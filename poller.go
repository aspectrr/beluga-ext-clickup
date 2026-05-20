package clickup

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/collinpfeifer/beluga/internal/core/eventstore"
	"github.com/collinpfeifer/beluga/internal/core/model"
	"github.com/collinpfeifer/beluga/internal/core/session"
)

// TriggerReason describes why a task was picked up by the poller.
type TriggerReason string

const (
	ReasonAssigned        TriggerReason = "assigned"
	ReasonMentioned       TriggerReason = "mentioned"
	ReasonThreadMentioned TriggerReason = "thread_mentioned"
	ReasonUpdated         TriggerReason = "updated"
	ReasonCreated         TriggerReason = "created"
)

// MentionInfo contains details about an @mention that triggered the handler.
type MentionInfo struct {
	CommentID       json.Number
	CommentText     string
	Author          string
	Date            string
	ParentCommentID json.Number
}

// TaskHandler is called for each task event found by the poller.
type TaskHandler func(task Task, isNew bool, reason TriggerReason, mention *MentionInfo)

// watchedThread tracks a comment thread the agent is engaged in.
type watchedThread struct {
	taskID      string
	parentID    json.Number
	lastReplyAt int64
}

// Poller polls the ClickUp API for updated tasks and comments.
type Poller struct {
	client            *Client
	cfg               Config
	handler           TaskHandler
	logger            *slog.Logger
	lastUpdated       int64
	processedComments map[string]bool
	watchedThreads    map[string]*watchedThread
	mu                sync.Mutex
	cancel            context.CancelFunc
	done              chan struct{}
}

// NewPoller creates a new task poller.
func NewPoller(client *Client, cfg Config, handler TaskHandler, logger *slog.Logger) *Poller {
	return &Poller{
		client:            client,
		cfg:               cfg,
		handler:           handler,
		logger:            logger,
		processedComments: make(map[string]bool),
		watchedThreads:    make(map[string]*watchedThread),
		done:              make(chan struct{}),
	}
}

// Start begins the polling loop in a background goroutine.
func (p *Poller) Start(ctx context.Context) {
	ctx, p.cancel = context.WithCancel(ctx)

	p.mu.Lock()
	p.lastUpdated = time.Now().UnixMilli()
	p.mu.Unlock()

	go p.run(ctx)
}

// Stop gracefully stops the poller.
func (p *Poller) Stop() {
	if p.cancel != nil {
		p.cancel()
	}
	<-p.done
}

func (p *Poller) run(ctx context.Context) {
	defer close(p.done)

	interval := 30 * time.Second
	if p.cfg.PollInterval != "" {
		if d, err := time.ParseDuration(p.cfg.PollInterval); err == nil {
			interval = d
		}
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	p.logger.Info("clickup poller started",
		"interval", interval,
		"team_id", p.cfg.TeamID,
		"agent_username", p.cfg.AgentUsername,
	)

	p.poll(ctx)

	for {
		select {
		case <-ctx.Done():
			p.logger.Info("clickup poller stopped")
			return
		case <-ticker.C:
			p.poll(ctx)
		}
	}
}

func (p *Poller) poll(ctx context.Context) {
	p.mu.Lock()
	since := p.lastUpdated
	p.mu.Unlock()

	opts := &TaskListOpts{
		OrderBy:       "updated",
		Reverse:       true,
		DateUpdatedGT: since,
		Subtasks:      true,
	}

	if p.cfg.ListID != "" {
		opts.ListIDs = []string{p.cfg.ListID}
	}
	if p.cfg.SpaceID != "" {
		opts.SpaceIDs = []string{p.cfg.SpaceID}
	}
	if p.cfg.Tag != "" {
		opts.Tags = []string{p.cfg.Tag}
	}
	if p.cfg.Assignee != "" {
		opts.Assignees = []string{p.cfg.Assignee}
	}

	tasks, err := p.client.GetTeamTasks(ctx, opts)
	if err != nil {
		p.logger.Error("clickup poll failed", "error", err)
		return
	}

	if len(tasks) == 0 {
		p.checkWatchedThreads(ctx)
		return
	}

	var newestUpdated int64
	for _, task := range tasks {
		updated := parseTimestamp(task.DateUpdated)
		if updated > newestUpdated {
			newestUpdated = updated
		}

		isNew := parseTimestamp(task.DateCreated) > since

		if isNew {
			p.handler(task, true, ReasonCreated, nil)
		} else if p.isAssignedToAgent(task) {
			p.handler(task, false, ReasonAssigned, nil)
		} else {
			p.handler(task, false, ReasonUpdated, nil)
		}

		if p.cfg.AgentUsername != "" {
			p.checkMentions(ctx, task, since)
		}
	}

	p.mu.Lock()
	if newestUpdated > p.lastUpdated {
		p.lastUpdated = newestUpdated
	}
	p.mu.Unlock()

	p.checkWatchedThreads(ctx)
}

func (p *Poller) isAssignedToAgent(task Task) bool {
	if p.cfg.Assignee == "" {
		return false
	}
	for _, a := range task.Assignees {
		if fmt.Sprintf("%d", a.ID) == p.cfg.Assignee || a.Username == p.cfg.AgentUsername {
			return true
		}
	}
	return false
}

func (p *Poller) checkMentions(ctx context.Context, task Task, since int64) {
	comments, err := p.client.GetComments(ctx, task.ID)
	if err != nil {
		p.logger.Error("failed to fetch comments for task", "task_id", task.ID, "error", err)
		return
	}

	mentionPattern := "@" + p.cfg.AgentUsername

	for _, comment := range comments {
		commentDate := parseTimestamp(comment.Date.String())

		if commentDate <= since {
			continue
		}
		if strings.EqualFold(comment.User.Username, p.cfg.AgentUsername) {
			continue
		}
		if p.processedComments[comment.ID.String()] {
			continue
		}
		if !containsMention(comment.CommentText, mentionPattern) {
			continue
		}

		p.logger.Info("agent mentioned in comment",
			"task_id", task.ID,
			"comment_id", comment.ID,
			"author", comment.User.Username,
		)

		p.processedComments[comment.ID.String()] = true

		if err := p.client.AddCommentReaction(ctx, comment.ID, "whale"); err != nil {
			p.logger.Warn("failed to add reaction to mention comment", "comment_id", comment.ID, "error", err)
		}
		if _, err := p.client.ReplyToComment(ctx, comment.ID, "🐋 Looking into this now..."); err != nil {
			p.logger.Warn("failed to post acknowledgment reply", "comment_id", comment.ID, "error", err)
		}

		p.handler(task, false, ReasonMentioned, &MentionInfo{
			CommentID:   comment.ID,
			CommentText: comment.CommentText,
			Author:      comment.User.Username,
			Date:        comment.Date.String(),
		})

		p.watchedThreads[comment.ID.String()] = &watchedThread{
			taskID:      task.ID,
			parentID:    comment.ID,
			lastReplyAt: commentDate,
		}
	}
}

func (p *Poller) checkWatchedThreads(ctx context.Context) {
	if len(p.watchedThreads) == 0 {
		return
	}

	mentionPattern := "@" + p.cfg.AgentUsername

	for _, wt := range p.watchedThreads {
		replies, err := p.client.GetCommentReplies(ctx, wt.parentID)
		if err != nil {
			p.logger.Error("failed to fetch thread replies", "parent_comment_id", wt.parentID, "error", err)
			continue
		}

		var newMentionReply *Comment
		var newestReplyDate int64

		for _, reply := range replies {
			replyDate := parseTimestamp(reply.Date.String())
			if replyDate > newestReplyDate {
				newestReplyDate = replyDate
			}

			if replyDate <= wt.lastReplyAt {
				continue
			}
			if strings.EqualFold(reply.User.Username, p.cfg.AgentUsername) {
				continue
			}
			if p.processedComments[reply.ID.String()] {
				continue
			}

			if containsMention(reply.CommentText, mentionPattern) {
				newMentionReply = &reply
			}
		}

		if newestReplyDate > wt.lastReplyAt {
			wt.lastReplyAt = newestReplyDate
		}

		if newMentionReply == nil {
			continue
		}

		p.processedComments[newMentionReply.ID.String()] = true

		task, err := p.client.GetTask(ctx, wt.taskID)
		if err != nil {
			p.logger.Error("failed to fetch task for thread mention", "task_id", wt.taskID, "error", err)
			continue
		}

		p.handler(*task, false, ReasonThreadMentioned, &MentionInfo{
			CommentID:       newMentionReply.ID,
			CommentText:     newMentionReply.CommentText,
			Author:          newMentionReply.User.Username,
			Date:            newMentionReply.Date.String(),
			ParentCommentID: wt.parentID,
		})
	}
}

func containsMention(text, pattern string) bool {
	return strings.Contains(strings.ToLower(text), strings.ToLower(pattern))
}

// parseTimestamp parses a ClickUp Unix ms timestamp string.
func parseTimestamp(s string) int64 {
	if s == "" {
		return 0
	}
	var ms int64
	for _, c := range s {
		if c >= '0' && c <= '9' {
			ms = ms*10 + int64(c-'0')
		}
	}
	return ms
}

// HandleTaskEvent creates sessions for ClickUp task events.
// This is the bridge between the poller and the agent loop.
func HandleTaskEvent(
	sessions *session.Store,
	events *eventstore.Store,
	createSession func(ctx context.Context, source, sourceID string, initialMessage string, metadata json.RawMessage) (*model.Session, error),
) TaskHandler {
	return func(task Task, isNew bool, reason TriggerReason, mention *MentionInfo) {
		ctx := context.Background()
		sourceID := task.ID

		if isNew {
			description := task.Description
			if description == "" {
				description = "(no description)"
			}
			taskContext := fmt.Sprintf("[ClickUp Task: %s]\nURL: %s\nStatus: %s\n\n%s",
				task.Name, task.URL, task.Status.Status, description)

			_, err := createSession(ctx, "clickup", sourceID, taskContext, json.RawMessage(`{}`))
			if err != nil {
				slog.Error("failed to create session for clickup task",
					"task_id", sourceID,
					"error", err,
				)
			}
			return
		}

		if reason == ReasonMentioned && mention != nil {
			comments, _ := sessions.ListByStatus(ctx, model.StatusCompleted, 1, 0)
			_ = comments // suppress unused warning

			description := task.Description
			if description == "" {
				description = "(no description)"
			}

			mentionContext := fmt.Sprintf("[ClickUp Task: %s — %s mentioned the agent]\nURL: %s\nStatus: %s\n\n%s\n\nMention: \"%s\"",
				task.Name, mention.Author, task.URL, task.Status.Status, description, mention.CommentText)

			_, err := createSession(ctx, "clickup", sourceID, mentionContext, json.RawMessage(`{}`))
			if err != nil {
				slog.Error("failed to create session for mentioned clickup task",
					"task_id", sourceID,
					"error", err,
				)
			}
			return
		}

		if reason == ReasonThreadMentioned && mention != nil {
			followUpMsg := fmt.Sprintf("[ClickUp Thread Follow-up: %s — %s replied]\nTask: %s\nURL: %s\n\n\"%s\"",
				task.Name, mention.Author, task.Name, task.URL, mention.CommentText)

			_, err := createSession(ctx, "clickup", sourceID, followUpMsg, json.RawMessage(`{}`))
			if err != nil {
				slog.Error("failed to create session for thread mention",
					"task_id", sourceID,
					"error", err,
				)
			}
			return
		}
	}
}

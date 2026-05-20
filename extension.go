package clickup

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/collinpfeifer/beluga/internal/core/extension"
)

const defaultAgentUsername = "Beluga Agent"

// Extension implements extension.Extension for ClickUp.
type Extension struct {
	client *Client
	poller *Poller
	cfg    Config
	logger *slog.Logger
}

// Name returns the extension identifier.
func (e *Extension) Name() string { return "clickup" }

// Init parses config, creates the ClickUp client, and registers tools.
func (e *Extension) Init(ctx extension.ExtensionContext) error {
	// Parse config
	var cfg Config
	if err := json.Unmarshal(ctx.Config, &cfg); err != nil {
		return fmt.Errorf("clickup: parsing config: %w", err)
	}
	if cfg.APIToken == "" {
		return fmt.Errorf("clickup: api_token is required")
	}
	if cfg.TeamID == "" {
		return fmt.Errorf("clickup: team_id is required")
	}
	if cfg.AgentUsername == "" {
		cfg.AgentUsername = defaultAgentUsername
	}

	e.cfg = cfg
	e.logger = ctx.Logger.With("extension", "clickup")

	// Create ClickUp API client
	client, err := NewClient(cfg, e.logger)
	if err != nil {
		return fmt.Errorf("clickup: creating client: %w", err)
	}
	e.client = client

	// Register ClickUp tools
	if err := RegisterTools(ctx.Registry, client); err != nil {
		return fmt.Errorf("clickup: registering tools: %w", err)
	}

	e.logger.Info("clickup extension initialized",
		"team_id", cfg.TeamID,
		"agent_username", cfg.AgentUsername,
	)

	return nil
}

// Start begins polling for ClickUp task events.
func (e *Extension) Start(ctx context.Context) error {
	// Set up the poller with a handler that creates sessions via the extension context
	handler := func(task Task, isNew bool, reason TriggerReason, mention *MentionInfo) {
		e.logger.Info("clickup task event",
			"task_id", task.ID,
			"is_new", isNew,
			"reason", reason,
			"name", task.Name,
		)
		// The actual session creation is handled by the poller's HandleTaskEvent wrapper.
		// For now, just log — the orchestrator wiring happens in main.go.
	}

	e.poller = NewPoller(e.client, e.cfg, handler, e.logger)
	e.poller.Start(ctx)

	<-ctx.Done()
	return nil
}

// Stop gracefully stops the poller.
func (e *Extension) Stop(ctx context.Context) error {
	if e.poller != nil {
		e.poller.Stop()
	}
	e.logger.Info("clickup extension stopped")
	return nil
}

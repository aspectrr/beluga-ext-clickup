package clickup

import "encoding/json"

// Task represents a ClickUp task.
type Task struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Status      Status `json:"status"`
	Description string `json:"description"`
	DateCreated string `json:"date_created"`
	DateUpdated string `json:"date_updated"`
	Creator     User   `json:"creator"`
	Assignees   []User `json:"assignees"`
	Tags        []Tag  `json:"tags"`
	Priority    *struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"priority"`
	DueDate string  `json:"due_date"`
	List    *List   `json:"list"`
	Folder  *Folder `json:"folder"`
	Space   *Space  `json:"space"`
	URL     string  `json:"url"`
}

// Status represents a task status.
type Status struct {
	Status string `json:"status"`
	Color  string `json:"color"`
	Type   string `json:"type"`
}

// User represents a ClickUp user.
type User struct {
	ID             int    `json:"id"`
	Username       string `json:"username"`
	Email          string `json:"email"`
	Initials       string `json:"initials"`
	ProfilePicture string `json:"profilePicture"`
}

// Tag represents a ClickUp tag.
type Tag struct {
	Name  string `json:"name"`
	TagFg string `json:"tag_fg"`
	TagBg string `json:"tag_bg"`
}

// List represents a ClickUp list.
type List struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Folder represents a ClickUp folder.
type Folder struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Space represents a ClickUp space.
type Space struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Comment represents a ClickUp task comment.
type Comment struct {
	ID          json.Number `json:"id"`
	TaskID      json.Number `json:"task_id"`
	User        User        `json:"user"`
	CommentText string      `json:"comment_text"`
	Date        json.Number `json:"date"`
}

// Attachment represents a ClickUp task attachment.
type Attachment struct {
	ID       string `json:"id"`
	TaskID   string `json:"task_id"`
	Title    string `json:"title"`
	URL      string `json:"url"`
	Date     string `json:"date"`
	MimeType string `json:"mime_type"`
	Size     int64  `json:"size"`
}

// TaskListOpts provides filtering options for GetTeamTasks.
type TaskListOpts struct {
	Page          int
	OrderBy       string
	Reverse       bool
	Statuses      []string
	ListIDs       []string
	SpaceIDs      []string
	Tags          []string
	Assignees     []string
	DateUpdatedGT int64
	IncludeClosed bool
	Subtasks      bool
}

// APIError represents an error returned by the ClickUp API.
type APIError struct {
	StatusCode int
	ErrorCode  string
	Message    string
}

func (e *APIError) Error() string {
	return e.FormatError()
}

// FormatError returns a formatted error string.
func (e *APIError) FormatError() string {
	return "clickup API error: " + e.Message
}

// Config holds the ClickUp extension configuration parsed from beluga.yaml.
type Config struct {
	Enabled       bool   `json:"enabled"`
	APIToken      string `json:"api_token"`
	TeamID        string `json:"team_id"`
	ListID        string `json:"list_id"`
	SpaceID       string `json:"space_id"`
	Tag           string `json:"tag"`
	Assignee      string `json:"assignee"`
	PollInterval  string `json:"poll_interval"`
	Proxy         string `json:"proxy"`
	WebhookSecret string `json:"webhook_secret"`
	AgentUsername string `json:"agent_username"`
}

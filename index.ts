// ── ClickUp Extension ─────────────────────────────────────────
// Ported from Go. ClickUp integration with polling + 6 tools.

import type {
	Extension,
	ExtensionContext,
	Tool,
	ToolDef,
	ToolContext,
} from "@aspectrr/beluga-sdk";
import type { Logger } from "pino";

// ── Types ──────────────────────────────────────────────────────

interface ClickUpConfig {
	enabled: boolean;
	api_token: string;
	team_id: string;
	space_id?: string;
	list_id?: string;
	agent_username: string;
	poll_interval: string;
	proxy?: string;
	webhook_secret?: string;
}

interface CUStatus {
	status: string;
	color: string;
	type: string;
}

interface CUUser {
	id: number;
	username: string;
	email: string;
	initials: string;
	profilePicture?: string;
}

interface CUTag {
	name: string;
	tag_fg: string;
	tag_bg: string;
}

interface CUTask {
	id: string;
	name: string;
	status: CUStatus;
	description?: string;
	date_created?: string;
	date_updated?: string;
	date_closed?: string;
	creator?: CUUser;
	assignees?: CUUser[];
	tags?: CUTag[];
	priority?: number;
	list?: { id: string; name: string };
	folder?: { id: string; name: string };
	space?: { id: string; name: string };
	url?: string;
}

interface CUComment {
	id: string;
	task_id: string;
	user: CUUser;
	comment_text: string;
	date: string;
}

interface CUAttachment {
	id: string;
	task_id: string;
	title: string;
	url: string;
	date: string;
	mime_type: string;
	size: number;
}

interface TaskListOpts {
	page?: number;
	order_by?: string;
	reverse?: boolean;
	statuses?: string[];
	list_ids?: string[];
	space_ids?: string[];
	tags?: string[];
	assignees?: string[];
	date_updated_gt?: number;
	include_closed?: boolean;
	subtasks?: boolean;
}

// ── ClickUp API Client ─────────────────────────────────────────

class ClickUpClient {
	private token: string;
	private teamId: string;
	private baseUrl = "https://api.clickup.com/api/v2";
	private logger: Logger;

	constructor(token: string, teamId: string, logger: Logger) {
		this.token = token;
		this.teamId = teamId;
		this.logger = logger;
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const maxRetries = 3;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const headers: Record<string, string> = {
					Authorization: this.token,
					"Content-Type": "application/json",
				};

				const opts: RequestInit = { method, headers };
				if (body) opts.body = JSON.stringify(body);

				const resp = await fetch(url, {
					...opts,
					signal: AbortSignal.timeout(30_000),
				});

				if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
					const text = await resp.text();
					throw new Error(`ClickUp API ${resp.status}: ${text}`);
				}

				if (resp.status === 429 || resp.status >= 500) {
					const delay = 2000 * (attempt + 1);
					this.logger.warn({ status: resp.status, attempt, delay }, "retrying ClickUp API");
					await new Promise((r) => setTimeout(r, delay));
					continue;
				}

				const text = await resp.text();
				if (!text) return {} as T;
				return JSON.parse(text) as T;
			} catch (err) {
				if (attempt === maxRetries - 1) throw err;
				const delay = 2000 * (attempt + 1);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
		throw new Error("max retries exceeded");
	}

	async getTeamTasks(opts: TaskListOpts = {}): Promise<CUTask[]> {
		const params = new URLSearchParams();
		if (opts.page) params.set("page", String(opts.page));
		params.set("order_by", opts.order_by ?? "updated");
		if (opts.reverse) params.set("reverse", "true");
		if (opts.subtasks) params.set("subtasks", "true");
		if (opts.include_closed) params.set("include_closed", "true");
		if (opts.date_updated_gt) params.set("date_updated_gt", String(opts.date_updated_gt));
		opts.statuses?.forEach((s) => params.append("statuses[]", s));
		opts.list_ids?.forEach((id) => params.append("list_ids[]", id));
		opts.space_ids?.forEach((id) => params.append("space_ids[]", id));
		opts.tags?.forEach((t) => params.append("tags[]", t));
		opts.assignees?.forEach((a) => params.append("assignees[]", a));

		const data = await this.request<{ tasks: CUTask[] }>(
			"GET",
			`/team/${this.teamId}/task?${params.toString()}`,
		);
		return data.tasks ?? [];
	}

	async getTask(taskId: string): Promise<CUTask> {
		return this.request("GET", `/task/${taskId}`);
	}

	async updateTask(taskId: string, updates: Record<string, unknown>): Promise<CUTask> {
		return this.request("PUT", `/task/${taskId}`, updates);
	}

	async postComment(taskId: string, text: string): Promise<CUComment> {
		return this.request("POST", `/task/${taskId}/comment`, { comment_text: text });
	}

	async replyToComment(commentId: string, text: string): Promise<CUComment> {
		return this.request("POST", `/comment/${commentId}/reply`, { comment_text: text });
	}

	async getComments(taskId: string): Promise<CUComment[]> {
		const data = await this.request<{ comments: CUComment[] }>("GET", `/task/${taskId}/comment`);
		return data.comments ?? [];
	}

	async getCommentReplies(commentId: string): Promise<CUComment[]> {
		const data = await this.request<{ comments: CUComment[] }>("GET", `/comment/${commentId}/reply`);
		return data.comments ?? [];
	}

	async getAttachments(taskId: string): Promise<CUAttachment[]> {
		const data = await this.request<{ attachments: CUAttachment[] }>("GET", `/task/${taskId}/attachment`);
		return data.attachments ?? [];
	}

	async addCommentReaction(commentId: string, emoji: string): Promise<void> {
		await this.request("POST", `/comment/${commentId}/reaction`, { emoji });
	}
}

// ── Tools ──────────────────────────────────────────────────────

function dryRun(): boolean {
	return process.env.BELUGA_DRY_RUN === "true";
}

class ClickUpGetTaskTool implements Tool {
	private client: ClickUpClient;
	constructor(client: ClickUpClient) { this.client = client; }

	definition(): ToolDef {
		return {
			name: "clickup_get_task",
			description: "Get full details of a ClickUp task by ID. Returns name, status, description, assignees, tags, dates, and other metadata.",
			parameters: {
				type: "object",
				properties: { task_id: { type: "string", description: "ClickUp task ID" } },
				required: ["task_id"],
			},
		};
	}

	async execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (dryRun()) return { status: "dry_run" };
		const task = await this.client.getTask(String(args.task_id));
		return task as unknown as Record<string, unknown>;
	}
}

class ClickUpUpdateTaskTool implements Tool {
	private client: ClickUpClient;
	constructor(client: ClickUpClient) { this.client = client; }

	definition(): ToolDef {
		return {
			name: "clickup_update_task",
			description: "Update a ClickUp task. Can change name, description, status, priority, assignees, and due date.",
			parameters: {
				type: "object",
				properties: {
					task_id: { type: "string", description: "Task ID" },
					name: { type: "string", description: "New task name" },
					description: { type: "string", description: "New description" },
					status: { type: "string", description: "New status" },
					priority: { type: "integer", description: "1=urgent, 2=high, 3=normal, 4=low" },
					due_date: { type: "string", description: "Due date as Unix ms timestamp" },
				},
				required: ["task_id"],
			},
		};
	}

	async execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (dryRun()) return { status: "dry_run" };
		const taskId = String(args.task_id);
		const updates: Record<string, unknown> = {};
		if (args.name) updates.name = args.name;
		if (args.description) updates.description = args.description;
		if (args.status) updates.status = args.status;
		if (args.priority) updates.priority = args.priority;
		if (args.due_date) updates.due_date = args.due_date;
		if (Object.keys(updates).length === 0) throw new Error("no fields to update");
		const task = await this.client.updateTask(taskId, updates);
		return task as unknown as Record<string, unknown>;
	}
}

class ClickUpPostCommentTool implements Tool {
	private client: ClickUpClient;
	constructor(client: ClickUpClient) { this.client = client; }

	definition(): ToolDef {
		return {
			name: "clickup_post_comment",
			description: "Post a comment on a ClickUp task. Use to report findings, status updates, or ask questions. Supports markdown.",
			parameters: {
				type: "object",
				properties: {
					task_id: { type: "string", description: "Task ID" },
					text: { type: "string", description: "Comment text (markdown supported)" },
				},
				required: ["task_id", "text"],
			},
		};
	}

	async execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (dryRun()) return { status: "dry_run" };
		const comment = await this.client.postComment(String(args.task_id), String(args.text));
		return comment as unknown as Record<string, unknown>;
	}
}

class ClickUpReplyCommentTool implements Tool {
	private client: ClickUpClient;
	constructor(client: ClickUpClient) { this.client = client; }

	definition(): ToolDef {
		return {
			name: "clickup_reply_comment",
			description: "Reply to a specific ClickUp comment in a thread.",
			parameters: {
				type: "object",
				properties: {
					comment_id: { type: "integer", description: "Comment ID to reply to" },
					text: { type: "string", description: "Reply text" },
				},
				required: ["comment_id", "text"],
			},
		};
	}

	async execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (dryRun()) return { status: "dry_run" };
		const comment = await this.client.replyToComment(String(args.comment_id), String(args.text));
		return comment as unknown as Record<string, unknown>;
	}
}

class ClickUpSearchTasksTool implements Tool {
	private client: ClickUpClient;
	constructor(client: ClickUpClient) { this.client = client; }

	definition(): ToolDef {
		return {
			name: "clickup_search_tasks",
			description: "Search for tasks in the ClickUp workspace. Filter by status, tags, assignees, list, or space.",
			parameters: {
				type: "object",
				properties: {
					statuses: { type: "array", items: { type: "string" }, description: "Filter by statuses" },
					tags: { type: "array", items: { type: "string" }, description: "Filter by tags" },
					assignees: { type: "array", items: { type: "string" }, description: "Filter by assignee IDs" },
					list_ids: { type: "array", items: { type: "string" }, description: "Filter by list IDs" },
					space_ids: { type: "array", items: { type: "string" }, description: "Filter by space IDs" },
					include_closed: { type: "boolean", description: "Include closed tasks" },
				},
			},
		};
	}

	async execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (dryRun()) return { tasks: [], count: 0 };
		const tasks = await this.client.getTeamTasks({
			statuses: args.statuses as string[] | undefined,
			tags: args.tags as string[] | undefined,
			assignees: args.assignees as string[] | undefined,
			list_ids: args.list_ids as string[] | undefined,
			space_ids: args.space_ids as string[] | undefined,
			include_closed: args.include_closed as boolean | undefined,
			order_by: "updated",
			reverse: true,
			subtasks: true,
		});
		const summaries = tasks.map((t) => ({
			id: t.id,
			name: t.name,
			status: t.status?.status,
			date_updated: t.date_updated,
			url: t.url,
			assignees: t.assignees?.map((a) => a.username),
			tags: t.tags?.map((tg) => tg.name),
		}));
		return { tasks: summaries, count: summaries.length };
	}
}

class ClickUpGetAttachmentsTool implements Tool {
	private client: ClickUpClient;
	constructor(client: ClickUpClient) { this.client = client; }

	definition(): ToolDef {
		return {
			name: "clickup_get_attachments",
			description: "Get all attachments for a ClickUp task. Returns file names, URLs, sizes, MIME types.",
			parameters: {
				type: "object",
				properties: { task_id: { type: "string", description: "Task ID" } },
				required: ["task_id"],
			},
		};
	}

	async execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (dryRun()) return { attachments: [], count: 0 };
		const attachments = await this.client.getAttachments(String(args.task_id));
		return { attachments, count: attachments.length };
	}
}

// ── Poller ─────────────────────────────────────────────────────

type TriggerReason = "assigned" | "mentioned" | "thread_mentioned" | "updated" | "created";

interface MentionInfo {
	commentId: string;
	commentText: string;
	author: string;
	date: string;
	parentCommentId?: string;
}

interface WatchedThread {
	taskId: string;
	parentId: string;
	lastReplyAt: number;
}

class Poller {
	private client: ClickUpClient;
	private cfg: ClickUpConfig;
	private handler: (task: CUTask, isNew: boolean, reason: TriggerReason, mention?: MentionInfo) => void;
	private logger: Logger;
	private lastUpdated = 0;
	private processedComments = new Map<string, boolean>();
	private watchedThreads = new Map<string, WatchedThread>();
	private intervalId?: ReturnType<typeof setInterval>;

	constructor(
		client: ClickUpClient,
		cfg: ClickUpConfig,
		handler: Poller["handler"],
		logger: Logger,
	) {
		this.client = client;
		this.cfg = cfg;
		this.handler = handler;
		this.logger = logger;
	}

	start(signal: AbortSignal): void {
		const intervalMs = this.parseInterval(this.cfg.poll_interval || "30s");
		this.poll().catch(() => {});

		this.intervalId = setInterval(() => {
			this.poll().catch(() => {});
		}, intervalMs);

		signal.addEventListener("abort", () => {
			if (this.intervalId) clearInterval(this.intervalId);
		});
	}

	stop(): void {
		if (this.intervalId) clearInterval(this.intervalId);
	}

	private parseInterval(s: string): number {
		const match = s.match(/^(\d+)(s|m|h)$/);
		if (!match) return 30_000;
		const n = parseInt(match[1]);
		if (match[2] === "s") return n * 1000;
		if (match[2] === "m") return n * 60_000;
		if (match[2] === "h") return n * 3_600_000;
		return 30_000;
	}

	private async poll(): Promise<void> {
		try {
			const opts: TaskListOpts = { order_by: "updated", reverse: true, subtasks: true };
			if (this.lastUpdated > 0) opts.date_updated_gt = this.lastUpdated;

			const tasks = await this.client.getTeamTasks(opts);
			if (tasks.length === 0) return;

			for (const task of tasks) {
				const updated = parseInt(task.date_updated ?? "0");
				if (updated > this.lastUpdated) this.lastUpdated = updated;
				await this.processTask(task);
			}

			await this.checkWatchedThreads();
		} catch (err) {
			this.logger.error({ err }, "poll error");
		}
	}

	private async processTask(task: CUTask): Promise<void> {
		const agentUsername = this.cfg.agent_username.toLowerCase();
		const comments = await this.client.getComments(task.id);

		for (const comment of comments) {
			const key = `${task.id}:${comment.id}`;
			if (this.processedComments.has(key)) continue;

			const text = comment.comment_text?.toLowerCase() ?? "";
			if (text.includes(`@${agentUsername}`)) {
				this.processedComments.set(key, true);

				try {
					await this.client.addCommentReaction(comment.id, "🐋");
					await this.client.replyToComment(comment.id, "🐋 Looking into this now...");
				} catch {
					// Non-fatal
				}

				const mention: MentionInfo = {
					commentId: comment.id,
					commentText: comment.comment_text,
					author: comment.user?.username ?? "unknown",
					date: comment.date,
				};

				this.handler(task, false, "mentioned", mention);

				this.watchedThreads.set(`${task.id}:${comment.id}`, {
					taskId: task.id,
					parentId: comment.id,
					lastReplyAt: parseInt(comment.date ?? "0"),
				});
			}
		}
	}

	private async checkWatchedThreads(): Promise<void> {
		for (const [_key, thread] of this.watchedThreads) {
			try {
				const replies = await this.client.getCommentReplies(thread.parentId);
				for (const reply of replies) {
					const replyKey = `${thread.taskId}:${reply.id}`;
					if (this.processedComments.has(replyKey)) continue;

					const text = reply.comment_text?.toLowerCase() ?? "";
					if (text.includes(`@${this.cfg.agent_username.toLowerCase()}`)) {
						this.processedComments.set(replyKey, true);
						this.handler(
							thread.taskId as unknown as CUTask,
							false,
							"thread_mentioned",
							{
								commentId: reply.id,
								commentText: reply.comment_text,
								author: reply.user?.username ?? "unknown",
								date: reply.date,
								parentCommentId: thread.parentId,
							},
						);
					}
					thread.lastReplyAt = parseInt(reply.date ?? "0");
				}
			} catch {
				// Continue checking other threads
			}
		}
	}
}

// ── Extension ──────────────────────────────────────────────────

class ClickUpExtension implements Extension {
	name = "clickup";
	private client!: ClickUpClient;
	private cfg!: ClickUpConfig;
	private poller?: Poller;
	private logger!: Logger;
	private createSession?: ExtensionContext["createSession"];

	async init(ctx: ExtensionContext): Promise<void> {
		const cfg = ctx.config as unknown as ClickUpConfig;
		if (!cfg.api_token) throw new Error("clickup: api_token is required");
		if (!cfg.team_id) throw new Error("clickup: team_id is required");

		cfg.agent_username = cfg.agent_username || "Beluga Agent";
		cfg.poll_interval = cfg.poll_interval || "30s";
		this.cfg = cfg;
		this.logger = ctx.logger;
		this.createSession = ctx.createSession;

		this.client = new ClickUpClient(cfg.api_token, cfg.team_id, ctx.logger);

		ctx.registry.register(new ClickUpGetTaskTool(this.client));
		ctx.registry.register(new ClickUpUpdateTaskTool(this.client));
		ctx.registry.register(new ClickUpPostCommentTool(this.client));
		ctx.registry.register(new ClickUpReplyCommentTool(this.client));
		ctx.registry.register(new ClickUpSearchTasksTool(this.client));
		ctx.registry.register(new ClickUpGetAttachmentsTool(this.client));

		ctx.logger.info(
			{ team_id: cfg.team_id, agent_username: cfg.agent_username },
			"clickup extension initialized",
		);
	}

	async start(signal: AbortSignal): Promise<void> {
		const handler = (task: CUTask, _isNew: boolean, reason: TriggerReason, mention?: MentionInfo) => {
			this.logger.info({ taskId: task.id, reason }, "task event detected");
		};

		this.poller = new Poller(this.client, this.cfg, handler, this.logger);
		this.poller.start(signal);
	}

	async stop(): Promise<void> {
		this.poller?.stop();
	}
}

export default new ClickUpExtension();

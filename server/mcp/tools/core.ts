import type { McpTool } from './define';

/**
 * Core MCP tools (owner: core module): whoami, search, list_notifications, mark_notifications_read, list_replies, add_reply, edit_reply, delete_reply, upload_attachment, list_attachments, get_attachment, delete_attachment, get_activity, subscribe, unsubscribe.
 * Declare each with `defineTool`; handlers call services only.
 */
export const coreTools: McpTool[] = [];

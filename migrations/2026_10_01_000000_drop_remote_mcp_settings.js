// @ts-check
// The ChatGPT connection (the remote MCP server and its OAuth clients) is gone,
// and its app_settings row would otherwise stay behind for good: the public
// address, the client list and the hashes of their secrets and grants, with
// nothing left that reads or revokes them.
//
// Nothing to bring back on the way down: the hashes were only ever good to
// the code that issued them.

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  await p.query('DELETE FROM `app_settings` WHERE `name` = ?', ['remote_mcp']);
}

export async function down() {}

# Paseo Dashboard

Paseo Dashboard shows live workspace and agent activity in one board. Use the display mode toggle to switch between workspace cards and individual agent tab cards. Unread, Needs attention, and Running are determined from Paseo's workspace and agent state; the plugin does not read or write workspace labels.

The three agent activity columns remain automatic and cannot be removed; their names, colors, and order are customizable. Workspace organization columns can be added, renamed, recolored, reordered, and removed; workspaces can be dragged between them. Column settings, workspace assignments, and ordering are saved host-wide. The dashboard also supports saved project views, search, pull request details, and live updates.

Open **Paseo Dashboard** from the app sidebar. Manage columns in **Settings → Plugins → Paseo Dashboard**. Reorder, rename, and recolor the three fixed activity columns; add, rename, recolor, reorder, or remove workspace organization columns. Idle, Paused, and Unfiltered are included initially.

The plugin uses Paseo's client SDK for live workspaces and agents and requires Paseo 0.12.0 or newer.

## Development

```powershell
npm install
npm run typecheck
paseo --host localhost:6767 plugin install G:\repos\paseo-dashboard
```

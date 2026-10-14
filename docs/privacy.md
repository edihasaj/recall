# Recall Privacy Policy

Effective date: 14 October 2026.

Recall is a local memory tool for coding agents maintained by Edi Hasaj.
This policy describes its Mac App Store edition.

## Local memory

Recall stores memories, project identifiers, agent activity, session context,
and its knowledge graph on your Mac, inside its App Sandbox container.
It does not send this information to Edi Hasaj or a Recall cloud service.
The app has no account, advertising, tracking, or enabled telemetry.

Agent activity can contain prompts, tool names, file paths, command summaries,
corrections, and selected assistant output. Recall applies redaction to
recognized sensitive patterns, but you should only connect sources whose
content you want retained in local memory.

## Connected agents

Agents you configure connect to Recall through local HTTP on your Mac.
They can retrieve selected memory context and submit activity and corrections.
Your coding agent or its model provider may process that context according
to the agent's own configuration and privacy policy. Recall does not control
what those separate applications send to their providers.

Connections and optional hooks are configured by you. Recall does not
automatically change other applications' configuration files or install
executables outside its bundle.

## Repository access and models

Recall reads repository files only within folders you choose through macOS.
Folder access is read-only and is remembered using security-scoped bookmarks.
Removing a folder revokes that access when the local service restarts.

Local embedding models may be downloaded from Hugging Face. These downloads
send the network information needed to retrieve model files, such as your IP
address and requested file, but do not send your memories or repository text.
Model files are cached locally in Recall's container.

## Control and retention

You can review, confirm, and reject memories in Recall. Rejected memories
remain available for local inspection but are excluded from normal memory
injection. Recall also keeps local activity and recovery backups according
to its retention settings.

Quit Recall to stop its local service and connected agents' access to it.
Launch at login is disabled until you enable it in Preferences.
Apple manages App Store downloads and updates under Apple's privacy policy.

## Contact

For privacy questions, contact <support@recallmemory.dev>.
Changes to this policy will be published here with an updated effective date.

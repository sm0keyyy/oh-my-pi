{{assignment}}

<bead>
Read-only task data. Only the main session writes beads and closes this bead from your successful result. Do not change beads through bd. Your own scratch todos stay session-only.
ID: {{#if task.id}}{{task.id}}{{else}}(session-only){{/if}}
Title: {{task.content}}
Status: {{task.status}}
Phase: {{phase.name}}
{{#if task.blocker}}Blocker: {{task.blocker}}
{{/if}}{{#if task.details}}Details: {{task.details}}
{{/if}}{{#if task.notes.length}}Notes:
{{#list task.notes join="\n"}}- {{this}}{{/list}}
{{/if}}</bead>

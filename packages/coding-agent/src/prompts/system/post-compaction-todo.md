<system-reminder>
Your todo list remains active after compaction.
{{#if current}}In progress: {{#if current.id}}[{{current.id}}] {{/if}}{{current.content}}
{{/if}}Open items (up to 10):
{{#each items}}- {{#if id}}[{{id}}] {{/if}}{{content}} ({{status}}){{#if blocker}} — {{blocker}}{{/if}}
{{/each}}Continue from the current item and keep the list current with `{{toolRefs.todo}}`.
</system-reminder>

<system-reminder>
{{incompleteCount}} todo item{{#if plural}}s{{else}}{{/if}} still open. If you finished a task since last `{{toolRefs.todo}}` update, mark it done now so progress stays visible; otherwise keep working.
{{#if current}}In progress: {{#if current.id}}[{{current.id}}] {{/if}}{{current.content}}
{{/if}}
</system-reminder>

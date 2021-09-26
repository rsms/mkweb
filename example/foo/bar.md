---
title: Bar
template: template2
---

# {{ title }}

Edit this file at `{{ relpath(cwd(), srcfile) }}`

Go to [Parent page]({{parent.url}})

----

## Here's this page's source

```md
{{ include(srcfile) }}
```

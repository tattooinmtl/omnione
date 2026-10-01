---
name: okf-card-author
description: Author an OKF (Open Knowledge Format) reference card for a tool, pattern, or gotcha. Card has frontmatter (id, title, type, tags) and a body of sections.
---

# OKF Card Author

Use this skill when the user asks for a reference card, a how-to, or a gotcha note in the OKF format.

## Card structure
```markdown
---
id: <stable-id>
title: <Human title>
type: reference | pattern | decision | snippet | gotcha
tags: [a, b, c]
---

# <Title>

## Why
<one paragraph>

## How
<numbered steps>

## Gotchas
- <one bullet per gotcha>
```

## Rules
- One concept per card
- Stable id (kebab-case, never change after publish)
- Frontmatter is required; the parser will reject the card without it
- Body must have Why, How, and Gotchas sections in that order

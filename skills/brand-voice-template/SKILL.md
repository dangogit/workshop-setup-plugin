---
name: brand-voice-setup
description: Set up a brand voice CLAUDE.md for a business. Interactive questionnaire that creates a personalized CLAUDE.md file. Use when user says "setup brand", "brand voice", "CLAUDE.md for my business", "configure my brand".
user-invocable: true
---

# Brand Voice Setup

Help the user create a personalized CLAUDE.md file for their business.

## Process

Ask the user these questions ONE AT A TIME:

1. **What's your business name?**

2. **What do you sell/offer?** (product, service, course, etc.)

3. **Who is your target audience?** (age, gender, profession, location)

4. **What language do you primarily work in?** (Hebrew, English, both)

5. **What's your brand tone?** Options:
   - Professional and authoritative
   - Friendly and conversational
   - Bold and provocative
   - Warm and personal
   - Technical and precise

6. **What are your brand colors?** (hex codes or descriptions)

7. **What platforms do you use?** (Instagram, Facebook, website, email, etc.)

8. **Any phrases or words you always/never use?**

## Output

Create a `CLAUDE.md` file in the project root with:

```markdown
# [Business Name]

## Brand
- Business: [description]
- Audience: [target audience]
- Tone: [selected tone]
- Language: [primary language]

## Style Guidelines
- Colors: [brand colors]
- Platforms: [platforms]
- Always: [preferred phrases/patterns]
- Never: [avoided phrases/patterns]

## Content Rules
- Write in [language] unless asked otherwise
- Use [tone] tone in all outputs
- Target audience is [audience description]
- Keep content aligned with [business type] industry
```

After creating the file, show the user what was created and explain:
"From now on, every time you use Claude Code in this project, it will know your brand."

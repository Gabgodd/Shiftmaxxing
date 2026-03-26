# AI Command Prompt Catalog (Shiftmaxxing)

This document is a **store of recommended prompts and variables** for a natural-language AI command layer.

It is designed around the architecture principle:

> AI suggests intent (structured JSON) → backend validates risk/scope → backend executes.

---

## 1) Current Tool Surface (what exists in this repo now)

Based on the current API routes, users can effectively perform:

- Agent management (`/api/agents`): create, list, update, delete.
- Shift management (`/api/shifts`): create/upsert, list, update, delete.
- Overtime logs (`/api/overtime`): create/upsert, list.

If the AI parser is used, these are the operational capabilities it should map into action contracts.

---

## 2) Recommended Action Contracts (V1)

Even though API routes are resource-oriented, the AI layer should expose a stable action set:

```json
[
  "create_time_off",
  "update_shift",
  "get_overtime",
  "get_schedule",
  "create_agent",
  "update_agent",
  "delete_agent",
  "log_overtime"
]
```

### Why include more than 4 actions?

The first four are your original MVP. The additional four map to existing backend behavior so users can ask naturally without API-shape leakage.

---

## 3) Shared Variables (Prompt Placeholders)

Use these placeholders in prompt templates:

- `{{agent_name}}` (e.g., "Yoda")
- `{{agent_id}}` (integer)
- `{{role}}` (e.g., "Support Agent")
- `{{timezone}}` (IANA tz, e.g., "America/New_York")
- `{{color_hex}}` (e.g., "#FFD700")
- `{{day_of_week}}` (Sunday..Saturday)
- `{{day_index}}` (0..6)
- `{{start_time_utc}}` / `{{end_time_utc}}` (hour decimal)
- `{{date}}` (YYYY-MM-DD)
- `{{start_date}}` / `{{end_date}}` (YYYY-MM-DD)
- `{{range}}` (`today`, `yesterday`, `past_week`, `week_to_date`, `this_month`, `custom`)
- `{{overtime_hours}}` (decimal)
- `{{released_hours}}` (decimal)
- `{{note}}` (free text)
- `{{scope}}` (`single_agent`, `team`, `all_agents`)
- `{{confirm_token}}` (`CONFIRM`)

---

## 4) Recommended Prompt Store

Each entry includes: natural language prompt, expected intent, and key variables.

## A. Scheduling / Time Off

1. **"Give {{agent_name}} time off from {{start_date}} to {{end_date}}."**
   - action: `create_time_off`
   - vars: `agent_name`, `start_date`, `end_date`

2. **"{{agent_name}} is out tomorrow."**
   - action: `create_time_off`
   - vars: `agent_name`, `start_date=end_date=tomorrow`

3. **"Mark {{agent_name}} unavailable on {{date}}."**
   - action: `create_time_off`
   - vars: `agent_name`, `date`

4. **"Move {{agent_name}} on {{day_of_week}} to {{start_time_utc}}-{{end_time_utc}} UTC."**
   - action: `update_shift`
   - vars: `agent_name`, `day_of_week`, `start_time_utc`, `end_time_utc`

5. **"Set {{agent_name}}'s Monday shift to 14:00-22:00 UTC."**
   - action: `update_shift`
   - vars: `agent_name`, `day_of_week=Monday`, `start_time_utc`, `end_time_utc`

6. **"Shorten {{agent_name}} by 1 hour today."**
   - action: `update_shift`
   - vars: `agent_name`, `date=today`, adjustment metadata

## B. Read-only Questions

7. **"How much overtime did {{agent_name}} do in the {{range}}?"**
   - action: `get_overtime`
   - vars: `agent_name`, `range`

8. **"Show me {{agent_name}}'s schedule this week."**
   - action: `get_schedule`
   - vars: `agent_name`, `range=this_week`

9. **"Who is scheduled right now in UTC?"**
   - action: `get_schedule`
   - vars: `range=now`

10. **"Give me overtime leaderboard for past week."**
    - action: `get_overtime`
    - vars: `range=past_week`, optional `scope=team`

11. **"How many released overtime hours did {{agent_name}} log this month?"**
    - action: `get_overtime`
    - vars: `agent_name`, `range=this_month`

## C. Agent Management

12. **"Create a new agent named {{agent_name}} in {{timezone}}."**
    - action: `create_agent`
    - vars: `agent_name`, `timezone`

13. **"Add {{agent_name}} as {{role}} with color {{color_hex}}."**
    - action: `create_agent`
    - vars: `agent_name`, `role`, `color_hex`

14. **"Update {{agent_name}} timezone to {{timezone}}."**
    - action: `update_agent`
    - vars: `agent_name`, `timezone`

15. **"Rename agent {{agent_name}} to {{note}}."**
    - action: `update_agent`
    - vars: identity + new name

16. **"Delete agent {{agent_name}}."**
    - action: `delete_agent`
    - vars: `agent_name`

## D. Overtime Logging

17. **"Log {{overtime_hours}} overtime hours for {{agent_name}} on {{date}}."**
    - action: `log_overtime`
    - vars: `agent_name`, `date`, `overtime_hours`

18. **"Set released overtime for {{agent_name}} on {{date}} to {{released_hours}}."**
    - action: `log_overtime`
    - vars: `agent_name`, `date`, `released_hours`

19. **"Add overtime note for {{agent_name}} on {{date}}: {{note}}."**
    - action: `log_overtime`
    - vars: `agent_name`, `date`, `note`

## E. High-risk / Confirmation Scenarios

20. **"Push all future shifts +1 hour for every agent."**
    - action: `bulk_update_shifts` (HIGH)
    - vars: `scope=all_agents`, future range

21. **"Delete all overtime logs before {{date}}."**
    - action: `bulk_delete_overtime` (HIGH)
    - vars: `date`, `scope`

22. **"Replace the whole weekly schedule for all agents."**
    - action: `bulk_replace_schedule` (HIGH)
    - vars: full schedule payload

23. **"Apply Friday template to all LATAM agents."**
    - action: `bulk_update_shifts` (HIGH)
    - vars: segment filter + template

24. **"Clear every shift and regenerate defaults."**
    - action: `reset_schedule` (HIGH)
    - vars: scope all

---

## 5) Suggested JSON Output Shape for Parser

```json
{
  "action": "get_overtime",
  "risk": "LOW",
  "confidence": 0.97,
  "params": {
    "agent": "gab",
    "range": "past_week"
  },
  "requires_confirmation": false,
  "reason": "Read-only overtime query"
}
```

For date-relative prompts (like "tomorrow"), parser should return normalized ISO dates based on request timestamp.

---

## 6) Validation Rules (must run server-side)

- Reject unknown actions.
- Reject missing required params.
- Enforce date format `YYYY-MM-DD`.
- Enforce shift bounds (`0 <= start < 24`, `end > start`, overnight explicit policy).
- Enforce timezone validity (IANA name).
- Resolve agent identity deterministically (name to id, disambiguate duplicates).
- Require `requires_confirmation=true` path for HIGH risk actions.

---

## 7) Recommended Prompt Categories for UI Presets

- **Quick command**: short imperative ("Move Yoda Monday shift to 14-22 UTC")
- **Question**: analytics query ("How much overtime did Gab do past week?")
- **Bulk/advanced**: guarded operations with warning chips

Preset chips can include:

- "Schedule time off"
- "Adjust shift"
- "Get overtime"
- "Show schedule"
- "Create agent"

---

## 8) Seed Pack for Testing (copy/paste)

1. `yoda is taking a day off from 2026-03-27 till 2026-03-29`
2. `how much overtime did gab do in the past week`
3. `move yoda monday shift to 14:00-22:00 utc`
4. `show me gab schedule this week`
5. `log 2.5 overtime hours for yoda on 2026-03-25`
6. `update yoda timezone to america/new_york`
7. `delete agent yoda`
8. `push all future shifts by +1 hour for all agents`

---

## 9) Store Format Option (for programmatic use)

If you want this catalog machine-readable, mirror each prompt in JSON:

```json
{
  "id": "prompt_001",
  "template": "Give {{agent_name}} time off from {{start_date}} to {{end_date}}",
  "action": "create_time_off",
  "risk": "MEDIUM",
  "variables": ["agent_name", "start_date", "end_date"],
  "example": {
    "input": "Give Yoda time off from 2026-03-27 to 2026-03-29",
    "output": {
      "action": "create_time_off",
      "params": {
        "agent": "yoda",
        "start_date": "2026-03-27",
        "end_date": "2026-03-29"
      }
    }
  }
}
```

---

## 10) Practical Guardrail Reminder

- Keep the parser strict and boring.
- Keep execution logic deterministic and audited.
- Never let prompt text decide safety.
- Always treat parser output as untrusted input until validated.

---

## 11) Local Testing Setup (Current Implementation)

- Endpoint: `POST /api/ai-command`
- Hardcoded access code (testing): `manager-test-123`
- OpenAI key source: `OPENAI_API_KEY` env var (or temporary hardcode in `server/routes.ts`)
- Supported parser actions in current server implementation:
  - `create_time_off`
  - `update_shift`
  - `get_overtime`
  - `get_schedule`

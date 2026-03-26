import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { db } from "./db";
import { agents, shifts } from "@shared/schema";

// Solflare-inspired agent default colors (yellow + dark accents)
const DEFAULT_COLORS = [
  "#FFD700", // gold
  "#FFA500", // amber
  "#FF6B35", // orange
  "#E63946", // red
  "#7B2FBE", // purple
  "#2196F3", // blue
  "#00BCD4", // cyan
  "#4CAF50", // green
  "#FF4081", // pink
  "#00E676", // lime
  "#FF9800", // deep orange
  "#9C27B0", // violet
  "#03A9F4", // light blue
];

// Default shifts: staggered around the clock for good coverage
const DEFAULT_SHIFTS = [
  { dayRange: [1,5], startUtc: 0, endUtc: 8 },   // A1 midnight-8am
  { dayRange: [1,5], startUtc: 2, endUtc: 10 },   // A2 2am-10am
  { dayRange: [1,5], startUtc: 4, endUtc: 12 },   // A3 4am-noon
  { dayRange: [1,5], startUtc: 6, endUtc: 14 },   // A4 6am-2pm
  { dayRange: [1,5], startUtc: 8, endUtc: 16 },   // A5 8am-4pm
  { dayRange: [1,5], startUtc: 10, endUtc: 18 },  // A6 10am-6pm
  { dayRange: [1,5], startUtc: 12, endUtc: 20 },  // A7 noon-8pm
  { dayRange: [1,5], startUtc: 14, endUtc: 22 },  // A8 2pm-10pm
  { dayRange: [1,5], startUtc: 16, endUtc: 24 },  // A9 4pm-midnight
  { dayRange: [1,5], startUtc: 18, endUtc: 26 },  // A10 6pm-2am
  { dayRange: [1,5], startUtc: 20, endUtc: 28 },  // A11 8pm-4am
  { dayRange: [1,5], startUtc: 22, endUtc: 30 },  // A12 10pm-6am
  { dayRange: [1,5], startUtc: 1, endUtc: 9 },    // A13 1am-9am
];

const TIMEZONES = [
  "UTC", "America/New_York", "America/Los_Angeles", "America/Sao_Paulo",
  "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Asia/Singapore",
  "Australia/Sydney", "Pacific/Auckland", "Africa/Nairobi", "Asia/Dubai", "Asia/Kolkata"
];

const TEST_MANAGER_ACCESS_CODE = "manager-test-123";
const OPENAI_MODEL = "gpt-4.1-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "REPLACE_WITH_OPENAI_KEY_FOR_TESTING";

type AIAction = "create_time_off" | "update_shift" | "get_overtime" | "get_schedule";

interface AIIntent {
  action: AIAction;
  agent?: string;
  day_of_week?: number;
  start_utc?: number;
  end_utc?: number;
  start_date?: string;
  end_date?: string;
  range?: "today" | "yesterday" | "past_week" | "week_to_date" | "this_month" | "custom";
  custom_start?: string;
  custom_end?: string;
}

const DAY_NAME_TO_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function parseIsoDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function toIsoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function clampDayIndex(input?: number) {
  if (typeof input !== "number") return undefined;
  return Math.max(0, Math.min(6, Math.floor(input)));
}

function resolveDateRange(range?: AIIntent["range"], customStart?: string, customEnd?: string) {
  const today = new Date();
  const todayIso = toIsoDate(today);
  const utcDay = today.getUTCDay();

  switch (range) {
    case "today":
      return { start: todayIso, end: todayIso };
    case "yesterday": {
      const y = addDays(today, -1);
      const iso = toIsoDate(y);
      return { start: iso, end: iso };
    }
    case "past_week":
      return { start: toIsoDate(addDays(today, -6)), end: todayIso };
    case "week_to_date":
      return { start: toIsoDate(addDays(today, -utcDay)), end: todayIso };
    case "this_month": {
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      return { start: toIsoDate(start), end: todayIso };
    }
    case "custom":
      if (!customStart || !customEnd) return null;
      return { start: customStart, end: customEnd };
    default:
      return { start: toIsoDate(addDays(today, -6)), end: todayIso };
  }
}

function normalizeDayOfWeek(value: unknown): number | undefined {
  if (typeof value === "number") return clampDayIndex(value);
  if (typeof value !== "string") return undefined;
  const normalized = DAY_NAME_TO_INDEX[value.trim().toLowerCase()];
  return normalized ?? undefined;
}

function findAgentByName(input?: string) {
  if (!input) return undefined;
  const needle = input.trim().toLowerCase();
  if (!needle) return undefined;
  return storage.getAgents().find((agent) => agent.name.toLowerCase() === needle)
    ?? storage.getAgents().find((agent) => agent.name.toLowerCase().includes(needle));
}

function safeParseJson(content: string): AIIntent | null {
  try {
    return JSON.parse(content) as AIIntent;
  } catch {
    const stripped = content.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    try {
      return JSON.parse(stripped) as AIIntent;
    } catch {
      return null;
    }
  }
}

async function parseIntentWithLLM(input: string): Promise<AIIntent> {
  if (!OPENAI_API_KEY || OPENAI_API_KEY.includes("REPLACE_WITH_OPENAI_KEY_FOR_TESTING")) {
    throw new Error("OPENAI_API_KEY missing. Set env OPENAI_API_KEY or hardcode a test key in routes.ts.");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You are an intent parser for a workforce manager tool.",
            "Return ONLY JSON object with no markdown.",
            "Allowed actions: create_time_off, update_shift, get_overtime, get_schedule.",
            "Do not invent actions.",
            "Use UTC values.",
            "For date requests, use ISO format YYYY-MM-DD.",
            "If a day is provided as text (e.g. Monday), return day_of_week as number 0-6 where 0=Sunday.",
            "If information is missing, still choose the best action and fill known fields only."
          ].join(" "),
        },
        { role: "user", content: input },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "ai_intent",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              action: { type: "string", enum: ["create_time_off", "update_shift", "get_overtime", "get_schedule"] },
              agent: { type: "string" },
              day_of_week: { anyOf: [{ type: "number" }, { type: "string" }] },
              start_utc: { type: "number" },
              end_utc: { type: "number" },
              start_date: { type: "string" },
              end_date: { type: "string" },
              range: { type: "string", enum: ["today", "yesterday", "past_week", "week_to_date", "this_month", "custom"] },
              custom_start: { type: "string" },
              custom_end: { type: "string" },
            },
            required: ["action"],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${detail}`);
  }

  const data = await response.json() as any;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("No content from OpenAI parser");

  const parsed = safeParseJson(content);
  if (!parsed) throw new Error("Failed to parse AI intent JSON");

  return parsed;
}

async function seedDefaultData() {
  const existing = storage.getAgents();
  if (existing.length > 0) return;

  // Create 13 agents
  const createdAgents = [];
  for (let i = 1; i <= 13; i++) {
    const agent = storage.createAgent({
      name: `Agent ${i}`,
      color: DEFAULT_COLORS[(i - 1) % DEFAULT_COLORS.length],
      avatarUrl: null,
      timezone: TIMEZONES[(i - 1) % TIMEZONES.length],
      role: "Support Agent",
    });
    createdAgents.push(agent);
  }

  // Create default shifts for each agent (Mon-Fri)
  for (let i = 0; i < createdAgents.length; i++) {
    const agent = createdAgents[i];
    const shiftTemplate = DEFAULT_SHIFTS[i];
    for (let day = shiftTemplate.dayRange[0]; day <= shiftTemplate.dayRange[1]; day++) {
      const rawStart = shiftTemplate.startUtc;
      const rawEnd = shiftTemplate.endUtc;
      // Normalize to 0-24 window: keep within bounds
      const normStart = rawStart % 24;
      const normEnd = Math.min(24, rawEnd > 24 ? rawEnd - 24 + normStart : rawEnd);
      storage.upsertShift({
        agentId: agent.id,
        dayOfWeek: day,
        startUtc: normStart,
        endUtc: normEnd > normStart ? normEnd : Math.min(24, normStart + 8),
        activeStart: null,
        activeEnd: null,
      });
    }
  }
}

export async function registerRoutes(httpServer: Server, app: Express) {
  await seedDefaultData();

  // --- Agents ---
  app.get("/api/agents", (_req, res) => {
    res.json(storage.getAgents());
  });

  app.post("/api/agents", (req, res) => {
    const agent = storage.createAgent(req.body);
    res.json(agent);
  });

  app.patch("/api/agents/:id", (req, res) => {
    const agent = storage.updateAgent(Number(req.params.id), req.body);
    if (!agent) return res.status(404).json({ message: "Not found" });
    res.json(agent);
  });

  app.delete("/api/agents/:id", (req, res) => {
    storage.deleteAgent(Number(req.params.id));
    res.json({ ok: true });
  });

  // --- Shifts ---
  app.get("/api/shifts", (_req, res) => {
    res.json(storage.getShifts());
  });

  app.post("/api/shifts", (req, res) => {
    const shift = storage.upsertShift(req.body);
    res.json(shift);
  });

  app.patch("/api/shifts/:id", (req, res) => {
    const shift = storage.updateShift(Number(req.params.id), req.body);
    if (!shift) return res.status(404).json({ message: "Not found" });
    res.json(shift);
  });

  app.delete("/api/shifts/:id", (req, res) => {
    storage.deleteShift(Number(req.params.id));
    res.json({ ok: true });
  });

  // --- Overtime ---
  app.get("/api/overtime", (_req, res) => {
    res.json(storage.getOvertimeLogs());
  });

  app.post("/api/overtime", (req, res) => {
    const { agentId, date, ...rest } = req.body;
    const log = storage.upsertOvertimeLog(agentId, date, rest);
    res.json(log);
  });

  // --- AI command parser + executor (testing) ---
  app.post("/api/ai-command", async (req, res) => {
    try {
      const { input, accessCode } = req.body ?? {};
      if (accessCode !== TEST_MANAGER_ACCESS_CODE) {
        return res.status(403).json({ message: "Access denied for AI manager command." });
      }

      if (!input || typeof input !== "string") {
        return res.status(400).json({ message: "input is required." });
      }

      const intent = await parseIntentWithLLM(input);
      const action = intent.action;
      const agent = findAgentByName(intent.agent);

      if ((action === "create_time_off" || action === "update_shift" || action === "get_overtime" || action === "get_schedule") && !agent) {
        return res.status(404).json({ message: "Agent not found for this request.", interpreted: intent });
      }

      switch (action) {
        case "get_overtime": {
          const range = resolveDateRange(intent.range, intent.custom_start, intent.custom_end);
          if (!range) return res.status(400).json({ message: "Invalid date range.", interpreted: intent });

          const logs = storage.getOvertimeByAgent(agent!.id).filter((log) => log.date >= range.start && log.date <= range.end);
          const totalOvertimeHours = logs.reduce((sum, log) => sum + log.overtimeHours, 0);
          const totalReleasedHours = logs.reduce((sum, log) => sum + log.releasedHours, 0);

          return res.json({
            interpreted: intent,
            result: {
              agent: agent!.name,
              range,
              totalOvertimeHours,
              totalReleasedHours,
              entries: logs,
            },
          });
        }

        case "get_schedule": {
          const agentShifts = storage.getShiftsByAgent(agent!.id)
            .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
            .map((shift) => ({
              id: shift.id,
              dayOfWeek: shift.dayOfWeek,
              startUtc: shift.startUtc,
              endUtc: shift.endUtc,
              activeStart: shift.activeStart,
              activeEnd: shift.activeEnd,
            }));

          return res.json({
            interpreted: intent,
            result: {
              agent: agent!.name,
              schedule: agentShifts,
            },
          });
        }

        case "update_shift": {
          const day = normalizeDayOfWeek(intent.day_of_week);
          if (day === undefined || typeof intent.start_utc !== "number" || typeof intent.end_utc !== "number") {
            return res.status(400).json({ message: "update_shift requires day_of_week, start_utc, end_utc", interpreted: intent });
          }

          const updated = storage.upsertShift({
            agentId: agent!.id,
            dayOfWeek: day,
            startUtc: intent.start_utc,
            endUtc: intent.end_utc,
            activeStart: null,
            activeEnd: null,
          });

          return res.json({
            interpreted: intent,
            result: {
              message: "Shift updated.",
              shift: updated,
            },
          });
        }

        case "create_time_off": {
          if (!intent.start_date || !intent.end_date) {
            return res.status(400).json({ message: "create_time_off requires start_date and end_date", interpreted: intent });
          }

          const start = parseIsoDate(intent.start_date);
          const end = parseIsoDate(intent.end_date);
          if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
            return res.status(400).json({ message: "Invalid date interval.", interpreted: intent });
          }

          const affectedWeekdays = new Set<number>();
          for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
            affectedWeekdays.add(cursor.getUTCDay());
          }

          const agentShifts = storage.getShiftsByAgent(agent!.id);
          const affected = [];
          for (const shift of agentShifts) {
            if (!affectedWeekdays.has(shift.dayOfWeek)) continue;
            const updated = storage.updateShift(shift.id, {
              activeStart: shift.startUtc,
              activeEnd: shift.startUtc,
            });
            if (updated) affected.push(updated);
          }

          return res.json({
            interpreted: intent,
            result: {
              message: "Time off applied as temporary active override for matching weekdays.",
              warning: "Current data model is weekday-based; this affects recurring weekday shifts.",
              affectedShiftCount: affected.length,
              shifts: affected,
            },
          });
        }

        default:
          return res.status(400).json({ message: "Unsupported action.", interpreted: intent });
      }
    } catch (error: any) {
      return res.status(500).json({ message: error?.message ?? "AI command failed." });
    }
  });
}

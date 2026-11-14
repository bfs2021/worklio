import type { JSONContent } from "@tiptap/react";

import type { CanvasTemplate } from "./types";

const text = (t: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const p = (...parts: (string | JSONContent)[]): JSONContent => ({
  type: "paragraph",
  content: parts.filter(Boolean).map((x) => (typeof x === "string" ? text(x) : x)),
});
const h = (level: 1 | 2 | 3, t: string): JSONContent => ({ type: "heading", attrs: { level }, content: [text(t)] });
const bold = (t: string) => text(t, [{ type: "bold" }]);
const bullets = (items: (string | JSONContent)[]): JSONContent => ({
  type: "bulletList",
  content: items.map((i) => ({ type: "listItem", content: [typeof i === "string" ? p(i) : i] })),
});
const numbered = (items: string[]): JSONContent => ({
  type: "orderedList",
  attrs: { start: 1 },
  content: items.map((i) => ({ type: "listItem", content: [p(i)] })),
});
const tasks = (items: string[]): JSONContent => ({
  type: "taskList",
  content: items.map((i) => ({ type: "taskItem", attrs: { checked: false }, content: [p(i)] })),
});
const callout = (t: string): JSONContent => ({ type: "blockquote", attrs: { variant: "callout" }, content: [p(t)] });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

export const TEMPLATES: CanvasTemplate[] = [
  {
    id: "meeting",
    name: "Meeting notes",
    emoji: "📝",
    description: "Agenda, notes, decisions and action items",
    title: "Meeting notes",
    content: doc(
      p(bold("Date: "), "—  ", bold("Attendees: "), "—"),
      h(2, "Agenda"),
      numbered(["Updates since last time", "Open questions", "Next steps"]),
      h(2, "Notes"),
      bullets([""]),
      h(2, "Decisions"),
      {
        type: "blockquote",
        content: [p("Write down what was decided, and why.")],
      },
      h(2, "Action items"),
      tasks(["Owner — task — due date", ""]),
    ),
  },
  {
    id: "brief",
    name: "Project brief",
    emoji: "🚀",
    description: "Goals, scope, milestones and owners",
    title: "Project brief",
    content: doc(
      h(2, "Overview"),
      p("One or two sentences on what we're building and who it's for."),
      h(2, "Goals"),
      bullets(["What does success look like?", "How will we measure it?"]),
      h(2, "Non-goals"),
      bullets(["What's explicitly out of scope"]),
      h(2, "Milestones"),
      tasks(["Kick-off", "First prototype", "Beta", "Launch"]),
      h(2, "Team"),
      bullets([p(bold("Lead: ")), p(bold("Design: ")), p(bold("Engineering: "))]),
      h(2, "Open questions"),
      bullets([""]),
    ),
  },
  {
    id: "checklist",
    name: "Checklist",
    emoji: "✅",
    description: "A simple list of things to get done",
    title: "Checklist",
    content: doc(
      p("Tick items off as you go — everyone in the channel sees progress live."),
      h(3, "To do"),
      tasks(["First thing", "Second thing", "Third thing"]),
      h(3, "Notes"),
      p(),
    ),
  },
  {
    id: "retro",
    name: "Retro",
    emoji: "🔁",
    description: "What went well, what didn't, what to try next",
    title: "Sprint retro",
    content: doc(
      p(bold("Sprint: "), "—  ", bold("Facilitator: "), "—"),
      callout("Keep it blameless: focus on the process, not the people."),
      h(2, "😊 What went well"),
      bullets([""]),
      h(2, "😕 What didn't go well"),
      bullets([""]),
      h(2, "💡 Ideas to try"),
      bullets([""]),
      h(2, "Action items"),
      tasks(["Owner — action — by when", ""]),
    ),
  },
  {
    id: "one-on-one",
    name: "1:1",
    emoji: "🤝",
    description: "Recurring one-on-one agenda and follow-ups",
    title: "1:1 notes",
    content: doc(
      p(bold("With: "), "—  ", bold("Cadence: "), "Weekly"),
      h(2, "Check-in"),
      p("How are things going, on a scale of 1–10? What's on your mind?"),
      h(2, "Topics"),
      tasks(["Their topic", "My topic"]),
      h(2, "Feedback"),
      bullets([p(bold("Wins: ")), p(bold("Growth areas: "))]),
      h(2, "Follow-ups"),
      tasks(["", ""]),
    ),
  },
];

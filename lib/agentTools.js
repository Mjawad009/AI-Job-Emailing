const history = require("./history");
const sequences = require("./sequences");
const emailGen = require("./emailGen");
const bounceDetector = require("./bounceDetector");
const replyDetector = require("./replyDetector");

// OpenAI-compatible tool schemas — this format is what OpenRouter expects
// for function-calling-capable models.
const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "get_analytics",
      description: "Get the user's email outreach stats: total sent, opened, clicked, replied, bounced, failed, and rates.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "search_history",
      description: "Search the user's sent-email history by recipient email, company, or contact name, or filter by status.",
      parameters: {
        type: "object",
        properties: {
          search: { type: "string", description: "Free-text search across email, company, contact name." },
          status: { type: "string", enum: ["sent", "failed", "bounced", "replied"] },
          limit: { type: "integer", description: "Max results, default 20." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_sequences",
      description: "List the user's existing follow-up sequences with step counts and active enrollment counts.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "create_sequence",
      description: "Create a new follow-up sequence (a set of automated emails sent over time to a prospect).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "A short name for the sequence." },
          steps: {
            type: "array",
            description: "Ordered list of steps. First step is usually delayDays 0.",
            items: {
              type: "object",
              properties: {
                delayDays: { type: "integer", description: "Days after the previous step (or enrollment) before this one sends." },
                instructions: { type: "string", description: "What angle this specific email should take." }
              },
              required: ["delayDays", "instructions"]
            }
          }
        },
        required: ["name", "steps"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "enroll_in_sequence",
      description: "Enroll a prospect into an existing sequence by name. Schedules (doesn't instantly send) the first email — it goes out on the next background sweep.",
      parameters: {
        type: "object",
        properties: {
          sequenceName: { type: "string", description: "Exact name of an existing sequence — use list_sequences first if unsure." },
          to: { type: "string", description: "Prospect's email address." },
          company: { type: "string" },
          contactName: { type: "string" },
          notes: { type: "string" }
        },
        required: ["sequenceName", "to"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "draft_email",
      description: "Write a one-off personalized outreach email for a prospect. ONLY prepares a draft for the user to review — does NOT send anything. Always tell the user you've prepared a draft, never say you sent it.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Prospect's email address." },
          company: { type: "string" },
          contactName: { type: "string" },
          notes: { type: "string" }
        },
        required: ["to", "company"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_bounces_now",
      description: "Trigger an immediate check of the user's inbox for bounce notifications (Gmail sending only).",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "check_replies_now",
      description: "Trigger an immediate check of the user's inbox for replies to sent emails (Gmail sending only).",
      parameters: { type: "object", properties: {}, required: [] }
    }
  }
];

async function execute(name, userId, args) {
  switch (name) {
    case "get_analytics":
      return history.stats(userId);

    case "search_history":
      return { results: await history.list(userId, { search: args.search, status: args.status, limit: args.limit || 20 }) };

    case "list_sequences":
      return { sequences: await sequences.listSequences(userId) };

    case "create_sequence": {
      const saved = await sequences.saveSequence(userId, { name: args.name, steps: args.steps || [] });
      return { ok: true, sequence: saved };
    }

    case "enroll_in_sequence": {
      const all = await sequences.listSequences(userId);
      const match = all.find(s => s.name.toLowerCase() === (args.sequenceName || "").toLowerCase());
      if (!match) {
        return { ok: false, error: `No sequence named "${args.sequenceName}" found. Available: ${all.map(s => s.name).join(", ") || "(none yet)"}` };
      }
      const enrollmentId = await sequences.enroll(userId, match.id, {
        to: args.to,
        company: args.company,
        contactName: args.contactName,
        notes: args.notes
      });
      return { ok: true, enrollmentId, sequenceName: match.name };
    }

    case "check_bounces_now":
      return bounceDetector.checkBouncesForUser(userId);

    case "check_replies_now":
      return replyDetector.checkRepliesForUser(userId);

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function draftEmail(userId, args) {
  const { subject, textBody } = await emailGen.generateForProspect(userId, {
    company: args.company,
    contactName: args.contactName,
    notes: args.notes
  });
  return { to: args.to, company: args.company, contactName: args.contactName, subject, body: textBody };
}

module.exports = { TOOL_SCHEMAS, execute, draftEmail };

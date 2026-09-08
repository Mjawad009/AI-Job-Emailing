const fetch = require("node-fetch");
const openrouter = require("./openrouter");
const usage = require("./usage");
const agentTools = require("./agentTools");
const activityLog = require("./activityLog");

const SYSTEM_PROMPT = `You are an assistant embedded in an outreach-email tool. You can look up the
user's analytics and send history, manage their follow-up sequences, enroll prospects into
sequences, trigger bounce/reply checks, and draft one-off emails.

Hard rule: you can NEVER send an email yourself. The draft_email tool only prepares a draft —
it does not send anything. After calling it, tell the user you've prepared a draft for them to
review and send themselves; never claim or imply an email went out unless the user tells you
they clicked send.

Enrolling a prospect in a sequence (enroll_in_sequence) is fine to do directly when asked — it
only schedules future sends, it doesn't send anything immediately either.

Be concise. When you use a tool, briefly say what you found or did in plain language rather than
dumping raw data back at the user.`;

const MAX_TOOL_ITERATIONS = 6;

async function callOpenRouterChat({ apiKey, model, messages, tools }) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, messages, tools, max_tokens: 1000, temperature: 0.4 })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error (${res.status}): ${text}`);
  }
  return res.json();
}

// Runs one full agent turn: takes the running conversation + a new user
// message, lets the model call tools as needed (looping until it produces a
// final text reply or hits the iteration cap), and returns the updated
// conversation plus any pending "review this draft" action for the UI.
async function runTurn(userId, conversationMessages, userMessage) {
  const { apiKey, model, usingOwnKey } = await openrouter.resolveCredentials(userId);
  if (!apiKey) {
    throw new Error(
      "No OpenRouter key available. Add your own in Settings, or the site operator needs to set PLATFORM_OPENROUTER_API_KEY."
    );
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversationMessages,
    { role: "user", content: userMessage }
  ];

  let pendingAction = null;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    let reserved = null;
    if (!usingOwnKey) {
      const result = await usage.reserve(userId);
      if (!result.allowed) {
        throw new Error(
          `You've hit today's limit (${result.limit}) for the free shared AI key. Add your own OpenRouter key in Settings for unlimited use, or try again tomorrow.`
        );
      }
      reserved = userId;
    }

    let data;
    try {
      data = await callOpenRouterChat({ apiKey, model, messages, tools: agentTools.TOOL_SCHEMAS });
    } catch (e) {
      if (reserved) await usage.release(reserved);
      throw e;
    }

    const choice = data.choices && data.choices[0];
    const msg = choice && choice.message;
    if (!msg) throw new Error("The AI assistant returned an empty response.");

    messages.push(msg);

    if (!msg.tool_calls || !msg.tool_calls.length) {
      return { messages: messages.slice(1), reply: msg.content || "", pendingAction };
    }

    for (const toolCall of msg.tool_calls) {
      const toolName = toolCall.function.name;
      let args = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch (e) {
        // fall through with empty args rather than crashing the whole turn
      }

      let resultForModel;
      if (toolName === "draft_email") {
        try {
          const draft = await agentTools.draftEmail(userId, args);
          pendingAction = { type: "send_email", draft };
          resultForModel = {
            ok: true,
            subject: draft.subject,
            body: draft.body,
            note: "Draft prepared and shown to the user for review. Do not say it was sent."
          };
        } catch (e) {
          resultForModel = { ok: false, error: e.message };
        }
      } else {
        try {
          resultForModel = await agentTools.execute(toolName, userId, args);
        } catch (e) {
          resultForModel = { ok: false, error: e.message };
        }
      }

      await activityLog.log(
        userId,
        "agent",
        resultForModel && resultForModel.ok === false ? "warn" : "info",
        `Used tool "${toolName}" with ${JSON.stringify(args)} → ${JSON.stringify(resultForModel).slice(0, 300)}`
      );

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(resultForModel)
      });
    }
  }

  return {
    messages: messages.slice(1),
    reply: "That took more steps than I could complete in one go — try breaking it into smaller requests.",
    pendingAction
  };
}

module.exports = { runTurn };

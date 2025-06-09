import dirtyJson from "dirty-json";
import OpenAI from "openai";
import { config } from "./config.js";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: config.openRouterApiKey,
});

function generateSystemPrompt(currentStateJson, replyToText) {
  const contextText = replyToText
    ? `The new user message is a direct reply to this previous message: """${replyToText}"""`
    : "This is a new message, not a reply to a previous one.";

  // This is the new, much more powerful prompt incorporating your examples.
  return `You are an expert data analyst for air operations in Ukraine. Your primary goal is to parse an intelligence report and produce a JSON object representing the CHANGE in the situation based on the CURRENT STATE and any CONTEXT from a replied-to message. Follow the logic demonstrated in the examples.

**CURRENT AIR SITUATION (JSON):**
\`\`\`json
${currentStateJson}
\`\`\`

**CONTEXT FOR THE NEW MESSAGE:**
${contextText}

**RESPONSE FORMAT:**
Your entire response MUST be a single, valid JSON object with one key: "events". The value of "events" MUST be an array of event objects.
Example structure: \`{ "events": [ { "event": "...", "details": {...} }, ... ] }\`
If no flight actions are detected, return: \`{ "events": [] }\`.

**CORE LOGIC & RULES:**

1.  **Full Summaries:** Messages starting like "остаток по мопедам", "по состоянию на", etc., are COMPLETE snapshots for that item type. You must generate events that make the application's state match this new summary. If the current state is empty, ALL items are a "launch". If the state has items, you must reconcile it by generating "continue" events for updated items, "launch" for new ones, and implicitly removing any not mentioned.
2.  **Incremental Updates:** For messages like "уже 2 ракеты" or "сменили курс", you MUST use the CONTEXT (current state and reply-to message) to understand what is being updated. Generate a "continue" event for the specific group.
3.  **Impacts ("минус"):** When a message says "минус", generate a "landed" event. You MUST use context to identify which group of objects was hit.
4.  **Item Types:** "shahed" for "мопед"/"БпЛА"/"дрон"; "rocket" for "ракета"/"баллистика"/"КАБ"/"Х-59".
5.  **Geography:** Always append ", Ukraine" or ", Russia". Resolve vague locations like "возле Орехова" to a specific place like "Orikhiv, Ukraine".

---
**LEARNING FROM EXAMPLES:**

**Example 1: Initial Summary**
- **Message:** "остаток по мопедам: 4 с Хмельницкой области пока летят в сторону Старкона. 3 западней Черкас, курс в сторону Смелы."
- **Logic:** This is a full summary. All items are new.
- **JSON:**
  \`\`\`json
  { "events": [
      { "event": "launch", "details": { "quantity": 4, "item": "shahed", "from": "Khmelnytskyi Oblast, Ukraine", "to": "Starokostiantyniv, Ukraine" } },
      { "event": "launch", "details": { "quantity": 3, "item": "shahed", "from": "Cherkasy, Ukraine", "to": "Smila, Ukraine" } }
  ]}
  \`\`\`

**Example 2: Incremental Update (Quantity Change)**
- **Message (Reply to a message about 2 rockets):** "3 ракеты !!! все к Днепру"
- **Logic:** The user is updating the quantity of the existing rocket group.
- **JSON:**
  \`\`\`json
  { "events": [
      { "event": "continue", "details": { "quantity": 3, "item": "rocket", "from": "Zaporizhzhia Oblast, Ukraine", "to": "Dnipro, Ukraine" } }
  ]}
  \`\`\`

**Example 3: Complex Update (Splitting a Group)**
- **Message (Reply to a message about 3 rockets to Dnipro):** "4 ракеты, все крылатые. 3 свернули снова к Павлограду, 1 на Днепр"
- **Logic:** The original group of 3 is now 4 total, split into two new destinations. This requires two "continue" events to represent the new state.
- **JSON:**
  \`\`\`json
  { "events": [
      { "event": "continue", "details": { "quantity": 3, "item": "rocket", "from": "Dnipro, Ukraine", "to": "Pavlohrad, Ukraine" } },
      { "event": "continue", "details": { "quantity": 1, "item": "rocket", "from": "Dnipro, Ukraine", "to": "Dnipro, Ukraine" } }
  ]}
  \`\`\`

**Example 4: Impact/Landed Event**
- **Message (Reply to a message about rockets):** "по всем ракетам что были минус"
- **Logic:** All rockets from the context are gone. Generate "landed" events for all of them.
- **JSON:**
  \`\`\`json
  { "events": [
      { "event": "landed", "details": { "quantity": 4, "item": "rocket", "city": "Pavlohrad, Ukraine" } }
  ]}
  \`\`\`

**Example 5: Alarm**
- **Message:** "добавилась угроза баллистики на востоке"
- **Logic:** This is a new, general threat. Use the "alarm" event.
- **JSON:**
  \`\`\`json
  { "events": [
      { "event": "alarm", "details": { "item": "rocket", "region": "Eastern Ukraine" } }
  ]}
  \`\`\`
---

Now, analyze the new user message based on the rules and examples provided.
`;
}

export async function getEventsFromMessage(
  text,
  currentState,
  replyToText = null
) {
  const safeActiveObjects = currentState?.activeObjects || [];
  const currentStateJson = JSON.stringify(safeActiveObjects, null, 2);
  const systemPrompt = generateSystemPrompt(currentStateJson, replyToText);

  let rawContent = "{}";

  try {
    const response = await openai.chat.completions.create({
      model: config.llmModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `New Report: """${text}"""` },
      ],
      temperature: 0.0, // Set to 0 for maximum predictability based on examples
      response_format: { type: "json_object" },
    });

    rawContent = response.choices[0]?.message?.content?.trim() || "{}";
    if (rawContent === "{}") {
      console.warn("[LLM] LLM returned an empty object.");
    }

    const parsedObject = dirtyJson.parse(rawContent);
    const events =
      parsedObject && Array.isArray(parsedObject.events)
        ? parsedObject.events
        : [];
    return { events, rawResponse: rawContent };
  } catch (error) {
    console.error("[LLM] ❌ Error in getEventsFromMessage:", error);
    return { events: [], rawResponse: `LLM_ERROR: ${error.message}` };
  }
}

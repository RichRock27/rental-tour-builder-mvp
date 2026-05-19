const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 4299);
const ROOT = __dirname;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 18 * 1024 * 1024) {
        request.destroy(new Error("Request body is too large."));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function cleanJsonText(text) {
  return String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractOutputText(payload) {
  if (payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (content.type === "text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function normalizeAnalysis(value) {
  const room = typeof value.room === "string" ? value.room.trim() : "Room";
  const title = typeof value.title === "string" ? value.title.trim() : room;
  const caption = typeof value.caption === "string" ? value.caption.trim() : "A guided stop in the rental tour.";
  const tags = Array.isArray(value.tags)
    ? value.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 5)
    : [];

  return {
    room,
    title,
    caption,
    tags: tags.length ? tags : ["Rental feature", "Photo tour", "Visible detail"]
  };
}

async function analyzePhoto(payload) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set in this terminal.");
  }

  if (!payload.image || !String(payload.image).startsWith("data:image/")) {
    throw new Error("Missing image data.");
  }

  const property = payload.property || {};
  const prompt = [
    "You are a rental listing photo analyst.",
    "Look at the image and describe only what is visible. Do not invent amenities, measurements, neighborhood claims, or appliance brands unless clearly visible.",
    "Return JSON only with this shape:",
    "{\"room\":\"Exterior|Living Room|Kitchen|Bedroom|Bathroom|Laundry|Balcony|Walk-in Closet|Storage|Amenities|Dining Area|Entry|Other\",\"title\":\"short polished title\",\"caption\":\"one polished rental-tour caption, 22-38 words, based on visible details\",\"tags\":[\"3 to 5 short visible feature tags\"]}",
    `Known property context: ${property.address || "unknown address"}; ${property.unitDetails || "rental unit"}.`,
    `Current guessed room label: ${payload.currentRoom || "unknown"}. File name: ${payload.fileName || "unknown"}.`
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: payload.image }
          ]
        }
      ],
      max_output_tokens: 450
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data.error?.message || `OpenAI request failed with ${response.status}.`;
    throw new Error(message);
  }

  const text = cleanJsonText(extractOutputText(data));
  try {
    return normalizeAnalysis(JSON.parse(text));
  } catch (error) {
    throw new Error(`The AI returned an unreadable response: ${text.slice(0, 240)}`);
  }
}

function serveFile(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const rawPath = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
  const filePath = path.normalize(path.join(ROOT, rawPath));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*"
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (request.url === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      hasOpenAIKey: Boolean(OPENAI_API_KEY),
      model: MODEL
    });
    return;
  }

  if (request.method === "POST" && request.url === "/api/analyze-photo") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const analysis = await analyzePhoto(payload);
      sendJson(response, 200, analysis);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  if (request.method === "GET") {
    serveFile(request, response);
    return;
  }

  sendJson(response, 405, { error: "Method not allowed." });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Rental Tour Builder running at http://127.0.0.1:${PORT}/`);
  console.log(`AI vision model: ${MODEL}`);
  console.log(OPENAI_API_KEY ? "OpenAI API key detected." : "OPENAI_API_KEY is missing.");
});

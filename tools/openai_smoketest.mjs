import fs from "node:fs";
import path from "node:path";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // remove surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// Load .env.local from project root (cwd)
loadEnvFile(path.resolve(process.cwd(), ".env.local"));
loadEnvFile(path.resolve(process.cwd(), ".env"));

const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.error("ERROR: OPENAI_API_KEY no está definido (ni en .env.local ni en el entorno).");
  process.exit(1);
}

console.log("OPENAI_API_KEY detectado:", {
  startsWithSk: key.startsWith("sk-"),
  length: key.length,
  preview: key.slice(0, 7) + "..." + key.slice(-4), // NO imprimir completa
});

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
console.log("Modelo:", model);

try {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Hola" }],
      max_tokens: 30,
      temperature: 0,
    }),
  });

  console.log("HTTP status:", res.status, res.statusText);
  const text = await res.text();

  // imprimir body (truncado) para ver errores de cuota/auth
  console.log("Body (truncado):", text.slice(0, 4000));

  if (!res.ok) process.exit(2);
} catch (err) {
  console.error("ERROR: Falló la llamada a OpenAI (network/SDK):", err);
  process.exit(3);
}


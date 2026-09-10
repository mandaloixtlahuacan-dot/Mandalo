export default function HomePage() {
  return (
    <main style={{ padding: "2rem", maxWidth: 560 }}>
      <h1 style={{ marginTop: 0 }}>Flujo Propio — Bot OK</h1>
      <p>
        Starter mínimo: webhook Whapi → OpenAI → reply. Usa{" "}
        <code>/api/health</code> y <code>/api/webhook</code>.
      </p>
    </main>
  );
}

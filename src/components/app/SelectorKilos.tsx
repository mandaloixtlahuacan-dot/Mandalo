"use client";

import { formatKilos, KILO_PRESETS, MAX_KILOS, parseKilos } from "@/lib/kiloLabel";

export function SelectorKilos({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const parsed = parseKilos(value);
  return (
    <div className="kilos">
      <div className="chips">
        {KILO_PRESETS.map((kilo) => (
          <button
            key={kilo}
            type="button"
            className={parsed === kilo ? "chip encendido" : "chip"}
            onClick={() => onChange(String(kilo))}
          >
            {formatKilos(kilo)}
          </button>
        ))}
      </div>
      <input
        className="campo"
        inputMode="decimal"
        value={value}
        placeholder="Otro peso, ej. 1.5"
        aria-label="Kilos"
        onChange={(event) => onChange(event.target.value)}
      />
      {value.trim() && parsed == null ? (
        <p className="aviso error">Escribe kilos mayores a 0 y hasta {MAX_KILOS}.</p>
      ) : null}
    </div>
  );
}

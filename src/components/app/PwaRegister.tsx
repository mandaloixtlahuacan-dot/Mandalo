"use client";

import { useEffect, useState } from "react";

type BeforeInstall = Event & { prompt: () => Promise<void> };

export function PwaRegister() {
  const [deferred, setDeferred] = useState<BeforeInstall | null>(null);
  const [ios, setIos] = useState(false);
  const [hide, setHide] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    }
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstall);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    const apple = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = window.matchMedia("(display-mode: standalone)").matches;
    setIos(apple && !standalone);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (hide || (!deferred && !ios)) return null;
  return (
    <div className="instalar">
      <span>{ios ? "En iPhone: Compartir y luego Agregar a inicio." : "Instálala en tu teléfono. No hace falta tienda de apps."}</span>
      {deferred ? (
        <button
          type="button"
          onClick={() => {
            void deferred.prompt();
            setHide(true);
          }}
        >
          Instalar
        </button>
      ) : (
        <button type="button" onClick={() => setHide(true)}>
          Ok
        </button>
      )}
    </div>
  );
}

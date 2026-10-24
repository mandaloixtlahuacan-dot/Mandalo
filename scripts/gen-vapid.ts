/**
 * Genera un par VAPID y lo imprime en la terminal.
 * No escribe archivos. No lo pegues en el repo.
 *
 *   npx tsx scripts/gen-vapid.ts
 *
 * En Vercel, proyecto mandalo1, solo Preview:
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY  = la pública
 *   VAPID_PRIVATE_KEY             = la privada
 *   VAPID_SUBJECT                 = https://mandalo1.vercel.app
 *
 * Un deployment ya hecho no las ve hasta el siguiente deploy.
 */
import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log("NEXT_PUBLIC_VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("VAPID_PRIVATE_KEY=" + keys.privateKey);
console.log("VAPID_SUBJECT=https://mandalo1.vercel.app");

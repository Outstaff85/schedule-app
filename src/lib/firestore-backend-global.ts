// The entry scripts/build-globals.mjs builds into firestore-backend.js: the
// plain script that defines the global initFirestoreBackend() for the manager
// page and the new pages' loadBackend() (src/lib/backend.ts).
import { initFirestoreBackend } from './firestore-backend';

window.initFirestoreBackend = initFirestoreBackend;

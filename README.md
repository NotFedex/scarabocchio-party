# Scarabocchio Party

Un party game multiplayer per browser, con stanze private, disegni, frasi e album dei risultati.

## Per chi gioca

**Non serve installare Node.js, app o altri programmi.** Una volta pubblicato il sito, ogni partecipante apre il link dal browser di PC, tablet o telefono, inserisce un nickname e crea/entra in una stanza. Il server Node viene eseguito nell'hosting, non sui dispositivi dei giocatori.

## Funzioni

- Stanze private con codice e link d'invito.
- Da 2 a 12 giocatori.
- Modalità: Telefono classico, Solo disegni, Solo frasi e Sprint.
- Disegno con matita, colori, gomma, spessore, annulla e pulisci.
- Turni sincronizzati in tempo reale e timer.
- Risultati in 5 viste: Album completo, Presentazione automatica, Passaggio per passaggio, Cronologia e Prima/Dopo.
- Riproduzione del processo di disegno per i disegni registrati.
- Ingrandimento dell'album, stampa/salvataggio PDF dal browser ed esportazione JSON.

## Pubblicazione online senza installare programmi sul tuo computer

Il progetto è già predisposto per **Render** tramite `render.yaml`. La pubblicazione si fa dal browser:

1. Crea un repository GitHub chiamato `scarabocchio-party` e carica il contenuto di questa cartella.
2. Apri [Render](https://render.com/) e accedi.
3. Seleziona **New + → Blueprint** e collega il repository GitHub.
4. Render leggerà `render.yaml`, installerà il runtime sul server cloud e avvierà il sito. Il runtime Node viene eseguito nell’hosting: sul tuo PC e sui dispositivi dei giocatori non si installa niente.
5. Usa l’indirizzo `https://...onrender.com` assegnato da Render per invitare tutti gli amici. Il server supporta WebSocket per sincronizzare le stanze in tempo reale.

Non devi installare Node.js sul PC. Node è utilizzato solo dal server cloud per mantenere le stanze multiplayer e la connessione in tempo reale.

## Avvio locale per sviluppatori (facoltativo)

Richiede Node.js 20+, ma è solo una modalità di sviluppo e non è necessaria per chi gioca online:

```bash
npm start
```

Aprire poi `http://localhost:3000`.

## Note tecniche

- Il server usa solo moduli nativi di Node.js; non ci sono dipendenze runtime esterne.
- Le stanze sono conservate in memoria: se il servizio cloud viene riavviato, le partite in corso vengono azzerate. Avvia una nuova stanza dopo un eventuale riavvio dell’hosting.
- Il piano gratuito Render può sospendere il servizio dopo 15 minuti senza traffico; al successivo accesso il risveglio può richiedere circa un minuto. Il client invia heartbeat mentre è collegato per mantenere attiva la sessione durante una partita.
- WebSocket viene usato per sincronizzare lobby, turni e risultati.

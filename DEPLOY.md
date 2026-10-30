# Pubblica Scarabocchio Party

Questa procedura è pensata per chi vuole giocare senza installare nulla sul proprio computer.

## 1. Crea il repository GitHub

Dal sito GitHub, crea un nuovo repository chiamato `scarabocchio-party`. Carica tutti i file di questa cartella mantenendo la struttura:

- `server.js`
- `package.json`
- `render.yaml`
- `public/` (con `index.html`, `client.js`, `style.css` e `favicon.svg`)

Non caricare `node_modules` (non è necessario).

## 2. Crea il servizio Render

1. Accedi a [render.com](https://render.com/).
2. Apri **New +** e seleziona **Blueprint**.
3. Collega GitHub e seleziona `scarabocchio-party`.
4. Conferma la creazione del servizio definito in `render.yaml`.

Render crea e avvia il server nel cloud. Non occorre Node.js sul computer da cui fai la pubblicazione.

## 3. Condividi il gioco

Quando Render mostra lo stato **Live**, apri il dominio assegnato (di solito termina in `.onrender.com`). Condividi quel link con gli amici. Ognuno potrà partecipare usando un browser aggiornato, senza download o installazioni.

## Nota sul piano gratuito

I servizi web gratuiti Render possono andare in sospensione dopo 15 minuti senza traffico. Al successivo accesso possono impiegare circa un minuto a riavviarsi. Durante una partita il browser invia piccoli heartbeat periodici sulla connessione WebSocket. Se il servizio viene comunque riavviato, le stanze in memoria si azzerano e va creata una nuova partita.

## Verifica

Aprendo `https://TUO-DOMINIO/health` deve apparire una risposta JSON con `ok: true`.

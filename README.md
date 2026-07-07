# Lead intake pipeline

Enquiries come in as messages (WhatsApp, a web form, email) and someone reads
each one, works out what's being asked and retypes it into a spreadsheet.
Thirty times a day. This turns the message into a record instead.

## Running it

```bash
cp .env.example .env
docker compose up -d
npm install && npm run migrate
npm start
```

```bash
curl -X POST localhost:3210/v1/leads \
  -H 'content-type: application/json' \
  -d '{"channel":"whatsapp","text":"hola, necesito lavado de 3 camionetas"}'
```

## Where it's at

Works end to end with a very stupid extractor. Next is getting the extraction
off the request path, then making it any good.

MIT.

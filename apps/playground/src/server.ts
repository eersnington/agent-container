import { createServer } from "node:http";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "4210", 10);

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("agent-container playground is not implemented yet in this incremental branch.\n");
});

server.listen(port, host, () => {
  process.stdout.write(`playground listening on http://${host}:${port}\n`);
});

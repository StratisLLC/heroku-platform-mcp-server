# @heroku-mcp/kafka

MCP tools for Apache Kafka on Heroku: cluster info, topics, and consumer groups. Sibling of [`@heroku-mcp/platform`](../platform-mcp), [`@heroku-mcp/postgres`](../postgres-mcp), and [`@heroku-mcp/key-value`](../key-value-mcp).

This package is a library: the hosted HTTP server registers its tools alongside the Platform, Postgres, and Key-Value tools so connecting clients (e.g. Claude Desktop) see one merged catalog.

> Not affiliated with Salesforce or Heroku. See [TRADEMARKS.md](https://github.com/StratisLLC/heroku-platform-mcp-server/blob/main/TRADEMARKS.md).

## Install

```bash
npm install @heroku-mcp/kafka
```

Requires Node ≥ 24.

## What's included

Pure HTTP control-plane tools (no Kafka-protocol broker operations, no CLI shellout). Five read tools:

| Group | Tools |
| --- | --- |
| Inventory & info | `kafka_list`, `kafka_info` |
| Topics | `kafka_topics_list`, `kafka_topics_info` |
| Consumer groups | `kafka_consumer_groups_list` |

Deliberately **not** in this package: topic create/delete, consumer-group management, and any Kafka-protocol data operations (produce/consume) — an explicit control-plane-only scope decision. Cluster credentials (`KAFKA_URL`, `KAFKA_CLIENT_CERT`, …) live in app config vars, not in control-plane responses, and are never returned here.

## Endpoints & auth

Kafka operations span two hosts, both authenticated with the same Heroku OAuth bearer token the core client already carries:

- **Platform API** (`api.heroku.com`) — `kafka_list` pages `/addons` and filters to the `heroku-kafka` service client-side (the Platform API has no server-side service filter).
- **Heroku Data API** (`api.data.heroku.com/data/kafka/v0/...`) — everything Kafka-specific (cluster info, topics, consumer groups), with internal fields stripped from responses.

`kafka_topics_info` reads the list endpoint and filters client-side, since the Data API exposes no single-topic endpoint.

## Capability probing

Gated on the `data.kafka` root tier. The topics and consumer-group tools additionally guard their own sub-tiers (`kafka_topics`, `kafka_consumer_groups`) so a tool fails fast with an actionable message when the family is gated. When the root tier is unavailable, no Kafka tools are advertised.

## Related

- [@heroku-mcp/core](https://www.npmjs.com/package/@heroku-mcp/core) — shared building blocks
- [@heroku-mcp/platform](https://www.npmjs.com/package/@heroku-mcp/platform) — Heroku Platform API tools
- [@heroku-mcp/http-server](https://www.npmjs.com/package/@heroku-mcp/http-server) — the deployable HTTP server that exposes these tools
- [Project documentation](https://github.com/StratisLLC/heroku-platform-mcp-server#readme)

## License

Apache-2.0

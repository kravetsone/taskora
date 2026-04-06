# Serializers

Taskora uses a `Serializer` to convert job data and results to/from strings for storage. The default serializer is JSON.

## Default JSON Serializer

```ts
import { json } from "taskora"

const app = taskora({
  adapter: redisAdapter("redis://localhost:6379"),
  serializer: json(), // this is the default — you don't need to specify it
})
```

## Custom Serializer

Implement the `Taskora.Serializer` interface to use a different format:

```ts
interface Serializer {
  serialize(value: unknown): string
  deserialize(raw: string): unknown
}
```

### Example: MessagePack

```ts
import { encode, decode } from "@msgpack/msgpack"

const msgpack: Taskora.Serializer = {
  serialize(value) {
    return Buffer.from(encode(value)).toString("base64")
  },
  deserialize(raw) {
    return decode(Buffer.from(raw, "base64"))
  },
}

const app = taskora({
  adapter: redisAdapter("redis://localhost:6379"),
  serializer: msgpack,
})
```

### Example: superjson

```ts
import superjson from "superjson"

const app = taskora({
  adapter: redisAdapter("redis://localhost:6379"),
  serializer: {
    serialize: (value) => superjson.stringify(value),
    deserialize: (raw) => superjson.parse(raw),
  },
})
```

The serializer is applied to both job **data** (input) and **results** (output). All tasks in an app share the same serializer.

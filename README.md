# node-red-contrib-event-calc

Node-RED nodes for event caching, streaming calculations, alarm management, and event framing.

## Overview

This package provides a local in-memory event hub with topic-based publish/subscribe and latest-value caching for reactive data flows within Node-RED. Stream data from MQTT, OPC-UA, or any source, then perform calculations that trigger automatically when values update.

Also includes ISA-88 batch structure tracking, ISA-18.2 alarm lifecycle management, and simple event recording.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  event-cache (config node)                                   │
│  • Stores: Map<topic, {value, ts, metadata, previous}>      │
│  • Event emitter for topic updates                           │
│  • LRU eviction, optional TTL                                │
└──────────────────────────────────────────────────────────────┘
         │                    │                    │
    ┌────▼────┐         ┌────▼────┐         ┌────▼────┐
    │event-in │         │event-   │         │event-   │
    │         │         │topic    │         │calc     │
    │ pushes  │         │subscribes│        │multi-sub│
    │to cache │         │to topic  │        │+ expr   │
    └─────────┘         └─────────┘         └─────────┘
```

## Installation

```bash
npm install node-red-contrib-event-calc
```

Or install directly from the Node-RED palette manager.

## Nodes

### Core Nodes

#### event-cache (Config Node)

Central cache that stores topic values and manages subscriptions. Configure:

- **Max Entries**: Maximum topics to cache (default: 10000). Oldest entries removed when exceeded.
- **TTL**: Time-to-live in milliseconds. Set to 0 for no expiry.

#### event-in

Receives messages from any upstream node and pushes values to the cache.

**Properties:**
- **Topic Field**: Where to get the topic (default: `msg.topic`)
- **Value Field**: Where to get the value (default: `msg.payload`)

The original message passes through, allowing insertion into existing flows.

#### event-topic

Subscribes to a topic and outputs when that topic updates.

**Properties:**
- **Topic**: Exact topic to subscribe to
- **Output Format**:
  - *Value only*: `msg.payload` = value
  - *Full entry*: `msg.payload` = `{value, ts, metadata}`
- **Output on deploy**: Emit cached values when flow starts

**Dynamic control via input:**
- `msg.topic`: Change subscription topic
- `msg.payload = 'refresh'`: Output current cached value

#### event-calc

Subscribes to multiple topics and evaluates an expression when values update.

**Properties:**
- **Input Variables**: Map variable names to topics
- **Expression**: JavaScript expression using the variables
- **Trigger**: When to calculate
  - *Any input updates*: Calculate on every update
  - *Only when all inputs have values*: Wait for all values
- **External Trigger**: When enabled, any incoming message triggers calculation using cached values

**Output:**
```json
{
  "topic": "calc/result",
  "payload": 21.5,
  "inputs": {
    "a": { "topic": "sensors/room1/temp", "value": 22, "ts": 1704000000000 },
    "b": { "topic": "sensors/room2/temp", "value": 21, "ts": 1704000001000 }
  },
  "expression": "(a + b) / 2",
  "trigger": "sensors/room1/temp"
}
```

### Event Frame Nodes

#### event-frame (ISA-88 Batch Structure)

Creates ISA-88 procedural model records with hierarchical parent-child linking.

**ISA-88 Levels:**
- **Procedure** — top-level batch recipe
- **Unit Procedure** — sequence within a unit
- **Operation** — major processing step
- **Phase** — lowest-level action

**Features:**
- Trigger-based: truthy starts, falsy ends
- Auto-generated UUIDs
- Parent-child linking via `parentLevel` config or `msg.frame_id` chaining
- Cascade end: ending a parent auto-ends all children recursively
- Shared global context tracker for cross-node coordination

**Output Record:**
```json
{
  "id": "auto-generated UUID",
  "starttime": "2024-01-15T10:30:00.000Z",
  "endtime": "9999-12-31T23:59:59.000Z",
  "name": "Mixing",
  "parent_id": "parent-uuid-or-empty",
  "level": "operation",
  "state": "running",
  "batch_id": "BATCH-001",
  "unit": "Reactor-1",
  "metadata": ""
}
```

#### simple-frame (Simple Event Recorder)

A simplified event frame for tracking any event with start/end time — no hierarchy, no cascade.

**Properties:**
- **Event Type**: Category label (str/msg/flow/global/env)
- **Event Name**: Descriptive name (str/msg/flow/global/env)
- **Metadata Field**: Optional msg property for extra data
- **Two outputs**: start and end

**Output Record:**
```json
{
  "id": "auto-generated UUID",
  "starttime": "2024-01-15T10:30:00.000Z",
  "endtime": "9999-12-31T23:59:59.000Z",
  "type": "maintenance",
  "name": "Oil Change",
  "state": "running",
  "metadata": ""
}
```

### Alarm Management

#### event-alarm (ISA-18.2 Alarm Lifecycle)

Tracks alarms through the full ISA-18.2 lifecycle with four outputs.

**Alarm States:**
- **UNACK_ALM** — Active + Unacknowledged (just raised)
- **ACK_ALM** — Active + Acknowledged (operator acked, condition still true)
- **UNACK_RTN** — Inactive + Unacknowledged (condition cleared, not yet acked)
- **NORM** — Normal (fully resolved)

**Lifecycle Paths:**
```
Path A: NORM → UNACK_ALM → ACK_ALM → NORM (ack first, then clear)
Path B: NORM → UNACK_ALM → UNACK_RTN → NORM (clear first, then ack)
```

**Properties:**
- **Condition ID/Name**: Alarm identifier and description
- **Input Mappings**: Map variable names to cache topics (like event-calc)
- **Condition**: Expression that evaluates to true/false (e.g. `active == true`)
- **Severity**: 0-1000 scale
- **4 Outputs**: raised, acknowledged, cleared, resolved

**Actions (via msg.payload):**
- `{ action: "ack", source: "topic" }` — Acknowledge specific alarm
- `{ action: "ack_all" }` — Acknowledge all active alarms
- `{ action: "list" }` — List all active alarms

### Utility Nodes

#### event-flatten

Flattens nested objects into individual topic/value pairs for the cache.

#### event-preview

Preview cached values directly in the Node-RED editor.

#### event-simulator

Generates simulated data for testing. Supports sine waves, random values, and ramps.

#### event-chart

Real-time charting node for visualizing cached event data.

## Built-in Functions (event-calc)

### Math
| Function | Description |
|----------|-------------|
| `min(a, b, ...)` | Minimum value |
| `max(a, b, ...)` | Maximum value |
| `abs(x)` | Absolute value |
| `sqrt(x)` | Square root |
| `pow(base, exp)` | Power |
| `log(x)`, `log10(x)` | Logarithms |
| `floor(x)`, `ceil(x)` | Rounding |
| `sin(x)`, `cos(x)`, `tan(x)` | Trigonometry |
| `PI`, `E` | Constants |

### Aggregation
| Function | Description |
|----------|-------------|
| `sum(a, b, ...)` | Sum of values |
| `avg(a, b, ...)` | Average of values |
| `count(a, b, ...)` | Count of values |

### Utility
| Function | Description |
|----------|-------------|
| `round(value, decimals)` | Round to N decimals |
| `clamp(value, min, max)` | Constrain to range |
| `map(value, inMin, inMax, outMin, outMax)` | Scale between ranges |
| `lerp(a, b, t)` | Linear interpolation |
| `ifelse(cond, trueVal, falseVal)` | Conditional |
| `between(value, min, max)` | Range check (returns boolean) |
| `delta(current, previous)` | Difference |
| `pctChange(current, previous)` | Percentage change |

### Change Detection
| Function | Description |
|----------|-------------|
| `now()` | Current timestamp in milliseconds |
| `prev('varName')` | Previous value of a variable |
| `hasChanged('varName')` | `true` if value differs from previous (false on first message) |
| `timeSinceLastChange('varName')` | Milliseconds since the value last changed |

### Date/Time
| Function | Description |
|----------|-------------|
| `hour()` | Current hour (0-23) |
| `minute()` | Current minute (0-59) |
| `second()` | Current second (0-59) |
| `day()` | Day of week (0=Sun, 1=Mon, ..., 6=Sat) |
| `dayOfMonth()` | Day of month (1-31) |
| `month()` | Month (1-12) |
| `year()` | Full year (e.g. 2026) |
| `isWeekday()` | `true` if Monday-Friday |
| `isWeekend()` | `true` if Saturday or Sunday |
| `hoursBetween(start, end)` | `true` if current hour is within range (wraps midnight) |

## Expression Examples

| Expression | Description |
|------------|-------------|
| `a + b` | Sum |
| `avg(a, b)` | Average |
| `max(a, b, c)` | Maximum |
| `sqrt(a*a + b*b)` | Pythagorean |
| `round(a, 2)` | Round to 2 decimals |
| `clamp(a, 0, 100)` | Constrain 0-100 |
| `map(a, 0, 1023, 0, 100)` | Scale ADC to % |
| `ifelse(a > b, 'high', 'low')` | Conditional |
| `hasChanged('temp')` | Did temperature just change? |
| `temp - prev('temp')` | Delta from previous value |
| `isWeekday() && hoursBetween(8, 18)` | During business hours? |

## API (for custom nodes)

The event-cache node exposes methods for programmatic access:

```javascript
const cache = RED.nodes.getNode(configId);

// Set a value
cache.setValue('topic/path', 42, { source: 'sensor' });

// Get a value
const entry = cache.getValue('topic/path');
// { value: 42, ts: 1704000000000, metadata: { source: 'sensor' }, previous: { value: 40, ts: ..., metadata: ... } }

// Subscribe to updates
const subId = cache.subscribe('sensors/room1/temp', (topic, entry) => {
    console.log(`${topic} = ${entry.value}`);
});

// Unsubscribe
cache.unsubscribe(subId);

// Get all topics
const topics = cache.getTopics();

// Clear cache
cache.clear();
```

## HTTP Admin Endpoints

```
GET  /event-cache/:id/stats    - Cache statistics
GET  /event-cache/:id/topics   - List all topics
POST /event-cache/:id/clear    - Clear cache
GET  /event-frame/tracker      - Current batch tracker state
GET  /event-alarm/:id/alarms   - Active alarms for a node
```

## License

Personal Use License - See [LICENSE](LICENSE) file.

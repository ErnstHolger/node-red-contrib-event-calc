# node-red-contrib-event-calc

Node-RED nodes for event caching and streaming calculations with a local pub/sub event hub.

## Overview

This package provides a local in-memory event hub with topic-based publish/subscribe and latest-value caching for reactive data flows within Node-RED. Stream data from MQTT, OPC-UA, or any source, then perform calculations that trigger automatically when values update.

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

### event-cache (Config Node)

Central cache that stores topic values and manages subscriptions. Configure:

- **Max Entries**: Maximum topics to cache (default: 10000). Oldest entries removed when exceeded.
- **TTL**: Time-to-live in milliseconds. Set to 0 for no expiry.

### event-in

Receives messages from any upstream node and pushes values to the cache.

**Properties:**
- **Topic Field**: Where to get the topic (default: `msg.topic`)
- **Value Field**: Where to get the value (default: `msg.payload`)

The original message passes through, allowing insertion into existing flows.

### event-topic

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

### event-calc

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

### event-json

Bidirectional JSON envelope converter for MQTT messaging.

**Behavior:**
- **Unwrap**: If payload is `{value, topic?, timestamp?}`, extracts to msg properties
- **Wrap**: If payload is any other value, wraps as `{timestamp, topic, value}`

**Usage:**
```
[MQTT in] → [event-json] → [event-in]     (unwrap JSON from broker)
[event-topic] → [event-json] → [MQTT out] (wrap for broker)
```

### event-simulator

Generates simulated data for testing. Supports sine waves, random values, and ramps.

### event-chart

Real-time charting node for visualizing cached event data.

## Examples

### Average Temperature

```
[inject: room1/temp] → [event-in] → [cache]
[inject: room2/temp] → [event-in] → [cache]

[event-calc] → [debug]
  inputs: a = sensors/room1/temp
          b = sensors/room2/temp
  expression: (a + b) / 2
  trigger: all
```

### Time-based Calculations (External Trigger)

```
[inject: every 1 min] → [event-calc (external trigger)] → [MQTT out]
  inputs: a = sensors/power
          b = sensors/voltage
  expression: a * b
```

### MQTT Round-trip with JSON Envelope

```
[MQTT in] → [event-json] → [event-in] → [cache]

[event-calc] → [event-json] → [MQTT out]
```

### Calculate Power (Voltage × Current)

```
[event-calc]
  inputs: v = power/voltage
          i = power/current
  expression: v * i
  topic: power/watts
```

## Built-in Functions

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

The cache automatically tracks the previous value for every topic. On the first message, `prev()` returns the same value as the current (so `hasChanged()` returns `false` and delta is `0`).

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
| `pctChange(a, b)` | % change from b to a |
| `hasChanged('temp')` | Did temperature just change? |
| `temp - prev('temp')` | Delta from previous value |
| `round(timeSinceLastChange('temp') / 1000, 1)` | Seconds since last change |
| `isWeekday() && hoursBetween(8, 18)` | During business hours? |
| `hoursBetween(22, 6)` | Night shift (wraps midnight) |
| `ifelse(isWeekend(), temp * 0.8, temp)` | Reduce setpoint on weekends |

## API (for custom nodes)

The event-cache node exposes methods for programmatic access:

```javascript
const cache = RED.nodes.getNode(configId);

// Set a value
cache.setValue('topic/path', 42, { source: 'sensor' });

// Get a value
const entry = cache.getValue('topic/path');
// { value: 42, ts: 1704000000000, metadata: { source: 'sensor' }, previous: { value: 40, ts: ..., metadata: ... } }

// Get previous value
const prev = cache.getPrevious('topic/path');
// { value: 40, ts: 1703999990000, metadata: { source: 'sensor' } }

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
GET  /event-cache/:id/stats   - Cache statistics
GET  /event-cache/:id/topics  - List all topics
POST /event-cache/:id/clear   - Clear cache
```

## License

Personal Use License - See [LICENSE](LICENSE) file.

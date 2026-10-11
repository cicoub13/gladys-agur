import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatePublisher } from '../src/publisher.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const dated = (id, state, day) => ({
  device_feature_external_id: id,
  state,
  created_at: new Date(Date.UTC(2026, 0, day)).toISOString(),
});
const undated = (id, state) => ({ device_feature_external_id: id, state });

// A clock that only moves when the publisher sleeps.
function fakeClock() {
  const clock = { now: 0, sleeps: [] };
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.now += ms;
  };
  return clock;
}

function createPublisher(gladys, options = {}) {
  const clock = fakeClock();
  const publisher = new StatePublisher({
    gladys,
    now: () => clock.now,
    sleep: clock.sleep,
    ...options,
  });
  return { publisher, clock };
}

test('dated states are sent once, then only the later ones', async () => {
  const gladys = createFakeGladys();
  const { publisher } = createPublisher(gladys);

  assert.equal(await publisher.publish([dated('a', 1, 1), dated('a', 2, 2), dated('b', 5, 1)]), 3);
  assert.equal(await publisher.publish([dated('a', 1, 1), dated('a', 2, 2), dated('b', 5, 1)]), 0);
  assert.equal(await publisher.publish([dated('a', 2, 2), dated('a', 3, 3)]), 1);
  assert.deepEqual(
    gladys.calls.states.map((state) => state.state),
    [1, 2, 5, 3],
  );
});

test('undated states are sent when their value changes', async () => {
  const gladys = createFakeGladys();
  const { publisher } = createPublisher(gladys);
  await publisher.publish([undated('balance', 10)]);
  await publisher.publish([undated('balance', 10)]);
  await publisher.publish([undated('balance', 12)]);
  assert.deepEqual(
    gladys.calls.states.map((state) => state.state),
    [10, 12],
  );
});

test('batches of 100 spaced to stay under the rate limit', async () => {
  const gladys = createFakeGladys();
  const { publisher, clock } = createPublisher(gladys, { maxPerMinute: 250 });
  const history = Array.from({ length: 450 }, (_, index) => dated('index', index, index + 1));

  assert.equal(await publisher.publish(history), 450);
  assert.deepEqual(gladys.calls.batches, [100, 100, 100, 100, 50]);
  // 200 states fit the first minute; the 3rd batch waits for them to age out,
  // then 100 + 100 + 50 = 250 fit the second one.
  assert.deepEqual(clock.sleeps, [60_000]);
});

test('forget() sends a device again in full, reset() everything', async () => {
  const gladys = createFakeGladys();
  const { publisher } = createPublisher(gladys);
  const states = [
    dated('ext:dev1:index', 1, 1),
    undated('ext:dev1:balance', 3),
    dated('ext:dev2:index', 2, 1),
  ];
  await publisher.publish(states);

  publisher.forget('ext:dev1:');
  assert.equal(await publisher.publish(states), 2);
  publisher.reset();
  assert.equal(await publisher.publish(states), 3);
});

test('a failed batch is not recorded, so it goes out again next time', async () => {
  const gladys = createFakeGladys();
  const { publisher } = createPublisher(gladys);
  gladys.failNext('publishStates');
  await assert.rejects(publisher.publish([dated('a', 1, 1)]), { status: 429 });
  // The queue keeps working after a failure.
  assert.equal(await publisher.publish([dated('a', 1, 1)]), 1);
});

test('a cancelled publication stops between batches and resumes later', async () => {
  const gladys = createFakeGladys();
  const { publisher } = createPublisher(gladys);
  const history = Array.from({ length: 250 }, (_, index) => dated('index', index, index + 1));
  let batches = 0;
  const sent = await publisher.publish(history, { isCancelled: () => batches++ >= 1 });
  assert.equal(sent, 100);
  assert.equal(await publisher.publish(history), 150);
});

test('publications run one after the other, never sending a state twice', async () => {
  const gladys = createFakeGladys();
  const { publisher } = createPublisher(gladys);
  const states = [dated('a', 1, 1), dated('a', 2, 2)];
  const counts = await Promise.all([publisher.publish(states), publisher.publish(states)]);
  assert.deepEqual(counts, [2, 0]);
  assert.equal(gladys.calls.states.length, 2);
});

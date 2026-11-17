/**
 * What Ghost's Stripe webhook does today for every kind of event and failure seen on Ghost(Pro):
 * the HTTP status Ghost responds with, which decides whether Stripe retries the event, the rows
 * Ghost writes, and the spans it records. Several of these outcomes are bugs or publisher setup
 * problems. The tests pin them as they are, so a change to any of them shows up here as a
 * deliberate change to its test.
 */
const assert = require('node:assert/strict');
const crypto = require('crypto');
const nock = require('nock');
const stripe = require('stripe');
const { agentProvider, mockManager, fixtureManager } = require('../../utils/e2e-framework');
const models = require('../../../core/server/models');
const db = require('../../../core/server/data/db');
const StripeAPI = require('../../../core/server/services/stripe/stripe-api');

/** The Stripe product of the paid tier in the members fixtures, and its monthly USD price. */
const FIXTURE_PRODUCT = '109c85c734fb9992e7bc30a26af66c22f5c94d8dc62e0a33cb797be902c06b2d';
const FIXTURE_PRICE = '173e16a1fffa7d232b398e4a9b08d266a456ae8f3d23e5f11cc608ced6730b12';
/** The Stripe customer of a paid member in the members fixtures. */
const FIXTURE_CUSTOMER = 'cus_HR3tBmNhx4QsZY';

/** Stripe's error responses, as Stripe returns them for each failure seen in production. */
const STRIPE = {
  accessRevoked: [
    401,
    {
      error: {
        type: 'invalid_request_error',
        code: 'platform_api_key_expired',
        message: 'Expired API Key provided: sk_live_***. Platform access may have been revoked.',
      },
    },
  ],
  locked: [
    429,
    {
      error: {
        type: 'invalid_request_error',
        code: 'lock_timeout',
        message:
          'This object cannot be accessed right now because another API request or Stripe process is currently accessing it.',
      },
    },
  ],
};

function stripeId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Each span recorded under `name`, as its outcome, the type of its error when it failed, and its
 * attributes.
 */
function spansOf(metrics, name) {
  return metrics.tracked(name).map(({ event, error, labels }) => ({
    outcome: event.outcome,
    ...(error ? { error: error.type } : {}),
    ...labels,
  }));
}

/**
 * A Stripe subscription with one monthly price, by default the fixture tier's, as Stripe returns it
 * at Ghost's API version.
 */
function subscriptionFor(customerId, { product = FIXTURE_PRODUCT, items, discount = null } = {}) {
  const price = {
    id: FIXTURE_PRICE,
    product,
    active: true,
    nickname: 'Monthly',
    currency: 'usd',
    recurring: { interval: 'month' },
    unit_amount: 500,
    type: 'recurring',
  };
  const now = Math.floor(Date.now() / 1000);
  return {
    id: stripeId('sub'),
    object: 'subscription',
    customer: customerId,
    status: 'active',
    items: { object: 'list', data: items ?? [{ id: stripeId('si'), price }] },
    plan: items ? null : { id: price.id, product },
    start_date: now,
    current_period_end: now + 60 * 60 * 24 * 31,
    cancel_at_period_end: false,
    discount,
    metadata: {},
  };
}

describe('Stripe webhook outcomes', function () {
  let membersAgent;
  let metrics;
  /** What the Stripe API mock returns, by method and path. Any other request gets a 404. */
  let stripeAnswers;

  function stripeAnswers404(uri) {
    return [
      404,
      {
        error: {
          type: 'invalid_request_error',
          code: 'resource_missing',
          message: `No such object: ${uri}`,
        },
      },
    ];
  }

  function answerStripe(method, uri, callback) {
    const path = uri.split('?')[0];
    const answer = stripeAnswers.find((a) => a.method === method && a.path === path);
    if (!answer) {
      return callback(null, stripeAnswers404(path));
    }
    if (answer.reply instanceof Error) {
      return callback(answer.reply);
    }
    return callback(null, answer.reply);
  }

  /** Makes the Stripe API mock return `reply` for `method path`: `[status, body]`, or an error that fails the request. */
  function stripeAnswersWith(method, path, reply) {
    stripeAnswers.unshift({ method, path, reply });
  }

  /**
   * Sends a signed Stripe event to the webhook and returns the HTTP status Ghost responded with.
   */
  async function send(type, object, { apiVersion = StripeAPI.API_VERSION } = {}) {
    const payload = JSON.stringify({
      id: stripeId('evt'),
      object: 'event',
      type,
      api_version: apiVersion,
      created: Math.floor(Date.now() / 1000),
      data: { object },
    });
    const { statusCode } = await membersAgent
      .post('/webhooks/stripe/')
      .body(payload)
      .header('content-type', 'application/json')
      .header(
        'stripe-signature',
        stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.WEBHOOK_SECRET }),
      );
    return statusCode;
  }

  /** A new Stripe customer with one subscription, which the Stripe API mock returns. */
  function stripeCustomer({
    email = `${stripeId('buyer')}@example.com`,
    name = 'Checkout Buyer',
  } = {}) {
    const id = stripeId('cus');
    const subscription = subscriptionFor(id);
    const customer = {
      id,
      object: 'customer',
      email,
      name,
      subscriptions: { object: 'list', data: [subscription] },
    };
    stripeAnswersWith('GET', `/v1/customers/${id}`, [200, customer]);
    stripeAnswersWith('GET', `/v1/subscriptions/${subscription.id}`, [200, subscription]);
    return { customer, subscription };
  }

  function subscriptionCheckout({ customer, subscription }, metadata = {}) {
    return {
      id: stripeId('cs'),
      object: 'checkout.session',
      mode: 'subscription',
      customer: customer?.id ?? null,
      subscription: subscription?.id ?? null,
      metadata,
    };
  }

  async function memberByEmail(email) {
    return await models.Member.findOne({ email }, { withRelated: ['stripeCustomers'] });
  }

  beforeAll(async function () {
    const agents = await agentProvider.getAgentsForMembers();
    membersAgent = agents.membersAgent;
    await fixtureManager.init('members');
  });

  beforeEach(function () {
    mockManager.mockMail();
    metrics = mockManager.mockMetrics();
    // Ghost fetches a subscription's price and product from Stripe whenever it links one.
    stripeAnswers = [
      {
        method: 'GET',
        path: `/v1/prices/${FIXTURE_PRICE}`,
        reply: [
          200,
          {
            id: FIXTURE_PRICE,
            object: 'price',
            product: FIXTURE_PRODUCT,
            active: true,
            nickname: 'Monthly',
            currency: 'usd',
            unit_amount: 500,
            type: 'recurring',
            recurring: { interval: 'month' },
          },
        ],
      },
      {
        method: 'GET',
        path: `/v1/products/${FIXTURE_PRODUCT}`,
        reply: [
          200,
          { id: FIXTURE_PRODUCT, object: 'product', name: 'Default Product', active: true },
        ],
      },
    ];
    for (const method of ['GET', 'POST', 'DELETE']) {
      nock('https://api.stripe.com')
        .persist()
        .intercept(/.*/, method)
        .reply(function (uri, _body, callback) {
          answerStripe(method, uri, callback);
        });
    }
  });

  afterEach(function () {
    mockManager.restore();
    nock.cleanAll();
  });

  describe('Requests Ghost can’t verify', function () {
    it('responds with 400 to a request without a signature, and records nothing', async function () {
      await membersAgent.post('/webhooks/stripe/').body({ fake: 'data' }).expectStatus(400);

      assert.deepEqual(spansOf(metrics, 'stripe.webhook'), []);
    });

    it('responds with 401 when the signature does not match the site’s webhook secret', async function () {
      await membersAgent
        .post('/webhooks/stripe/')
        .body({ fake: 'data' })
        .header('stripe-signature', 'dodgy')
        .expectStatus(401);

      assert.deepEqual(spansOf(metrics, 'stripe.webhook'), [
        {
          outcome: 'failure',
          error: 'STRIPE_WEBHOOK_SIGNATURE_MISMATCH',
          result: 'failed',
          reason: 'signature_mismatch',
          owner: 'site',
        },
      ]);
    });

    it('responds with 401 when the site has no webhook secret', async function () {
      const stripeService = require('../../../core/server/services/stripe');
      const secret = stripeService.webhookManager.webhookSecret;
      stripeService.webhookManager.webhookSecret = null;
      try {
        const status = await send(
          'customer.subscription.updated',
          subscriptionFor(stripeId('cus')),
        );

        assert.equal(status, 401);
        assert.deepEqual(spansOf(metrics, 'stripe.webhook'), [
          {
            outcome: 'failure',
            error: 'STRIPE_WEBHOOK_SECRET_MISSING',
            result: 'failed',
            reason: 'webhook_secret_missing',
            owner: 'site',
          },
        ]);
      } finally {
        stripeService.webhookManager.webhookSecret = secret;
      }
    });
  });

  describe('Events Ghost ignores', function () {
    it('responds with 200 to an event type it has no handler for', async function () {
      const status = await send('product.created', { id: stripeId('prod') });

      assert.equal(status, 200);
      assert.deepEqual(spansOf(metrics, 'stripe.webhook'), [
        {
          outcome: 'success',
          type: 'product.created',
          kind: 'unhandled',
          result: 'ignored',
          reason: 'unhandled_type',
        },
      ]);
    });

    it('handles an event sent at a different Stripe API version the same as one at Ghost’s version', async function () {
      const status = await send(
        'product.created',
        { id: stripeId('prod') },
        { apiVersion: '2099-01-01' },
      );

      assert.equal(status, 200);
      assert.deepEqual(spansOf(metrics, 'stripe.webhook'), [
        {
          outcome: 'success',
          type: 'product.created',
          kind: 'unhandled',
          result: 'ignored',
          reason: 'unhandled_type',
        },
      ]);
    });

    it('responds with 200 to a subscription event for a customer on the ignore list, and records it as ignored', async function () {
      const stripeService = require('../../../core/server/services/stripe');
      stripeService.webhookController.configure({ webhookCustomerIgnoreList: ['cus_ignored'] });
      try {
        const status = await send('customer.subscription.updated', subscriptionFor('cus_ignored'));

        assert.equal(status, 200);
        assert.deepEqual(spansOf(metrics, 'stripe.webhook'), [
          {
            outcome: 'success',
            type: 'customer.subscription.updated',
            kind: 'subscription',
            result: 'ignored',
            reason: 'listed_customer',
          },
        ]);
      } finally {
        stripeService.webhookController.configure({});
      }
    });
  });

  describe('checkout.session.completed', function () {
    it('creates a paid member for the buyer', async function () {
      const bought = stripeCustomer();

      const status = await send('checkout.session.completed', subscriptionCheckout(bought));

      assert.equal(status, 200);
      const member = await memberByEmail(bought.customer.email);
      assert.equal(member.get('status'), 'paid');
      assert.deepEqual(spansOf(metrics, 'stripe_checkout.complete'), [
        {
          outcome: 'success',
          type: 'subscription',
          member: 'new',
          shipping: 'none',
          phone: 'none',
        },
      ]);
    });

    it('responds with 500 on every attempt when the checkout’s metadata has newsletters this site doesn’t have, as another site’s checkout on the same Stripe account does', async function () {
      const bought = stripeCustomer();
      const otherSitesNewsletters = JSON.stringify([{ id: 'a00000000000000000000001' }]);

      const status = await send(
        'checkout.session.completed',
        subscriptionCheckout(bought, { newsletters: otherSitesNewsletters }),
      );

      assert.equal(status, 500);
      assert.equal(await memberByEmail(bought.customer.email), null);
      assert.deepEqual(spansOf(metrics, 'stripe_checkout.complete'), [
        {
          outcome: 'failure',
          error: '_OTHER',
          result: 'failed',
          reason: 'unclassified',
          owner: 'ghost',
          type: 'subscription',
          member: 'new',
          shipping: 'none',
          phone: 'none',
        },
      ]);
    });

    it('responds with 500 on every attempt when the checkout’s metadata has an offer this site doesn’t have, as another site’s checkout on the same Stripe account can', async function () {
      const bought = stripeCustomer();

      const status = await send(
        'checkout.session.completed',
        subscriptionCheckout(bought, { offer: 'a00000000000000000000002' }),
      );

      assert.equal(status, 500);
      assert.deepEqual(spansOf(metrics, 'stripe_checkout.complete'), [
        {
          outcome: 'failure',
          error: 'ER_NO_REFERENCED_ROW_2',
          result: 'failed',
          reason: 'unclassified',
          owner: 'ghost',
          type: 'subscription',
          member: 'new',
          shipping: 'none',
          phone: 'none',
        },
      ]);
    });

    it('creates a free member and then responds with 500 on every attempt when the buyer’s name is longer than the name column', async function () {
      const bought = stripeCustomer({ name: 'x'.repeat(250) });

      const status = await send('checkout.session.completed', subscriptionCheckout(bought));

      assert.equal(status, 500);
      const member = await memberByEmail(bought.customer.email);
      assert.equal(member.get('status'), 'free');
      assert.equal(member.related('stripeCustomers').length, 0);
      assert.deepEqual(spansOf(metrics, 'stripe_checkout.complete'), [
        {
          outcome: 'failure',
          error: '_OTHER',
          result: 'failed',
          reason: 'unclassified',
          owner: 'ghost',
          type: 'subscription',
          member: 'new',
          shipping: 'none',
          phone: 'none',
        },
      ]);
    });

    it('responds with 422 when the buyer’s email is invalid', async function () {
      const bought = stripeCustomer({ email: 'not an email@example' });

      const status = await send('checkout.session.completed', subscriptionCheckout(bought));

      assert.equal(status, 422);
      assert.deepEqual(spansOf(metrics, 'stripe_checkout.complete'), [
        {
          outcome: 'failure',
          error: 'ValidationError',
          result: 'failed',
          reason: 'unclassified',
          owner: 'ghost',
          type: 'subscription',
          member: 'new',
          shipping: 'none',
          phone: 'none',
        },
      ]);
    });

    it('responds with 429 when Stripe returns a lock timeout for the customer', async function () {
      const id = stripeId('cus');
      stripeAnswersWith('GET', `/v1/customers/${id}`, STRIPE.locked);

      const status = await send(
        'checkout.session.completed',
        subscriptionCheckout({ customer: { id } }),
      );

      assert.equal(status, 429);
      assert.deepEqual(spansOf(metrics, 'stripe_checkout.complete'), [
        {
          outcome: 'failure',
          error: 'lock_timeout',
          result: 'failed',
          reason: 'stripe_unavailable',
          owner: 'dependency',
          type: 'subscription',
          shipping: 'none',
          phone: 'none',
        },
      ]);
    });

    it('responds with 401 when the publisher has revoked Ghost’s access to their Stripe account', async function () {
      const id = stripeId('cus');
      stripeAnswersWith('GET', `/v1/customers/${id}`, STRIPE.accessRevoked);

      const status = await send(
        'checkout.session.completed',
        subscriptionCheckout({ customer: { id } }),
      );

      assert.equal(status, 401);
      assert.deepEqual(spansOf(metrics, 'stripe_checkout.complete'), [
        {
          outcome: 'failure',
          error: 'platform_api_key_expired',
          result: 'failed',
          reason: 'stripe_access_revoked',
          owner: 'site',
          type: 'subscription',
          shipping: 'none',
          phone: 'none',
        },
      ]);
    });

    it('responds with 500 when Ghost cannot reach Stripe', async function () {
      const id = stripeId('cus');
      stripeAnswersWith(
        'GET',
        `/v1/customers/${id}`,
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      );

      const status = await send(
        'checkout.session.completed',
        subscriptionCheckout({ customer: { id } }),
      );

      assert.equal(status, 500);
      assert.deepEqual(spansOf(metrics, 'stripe_checkout.complete'), [
        {
          outcome: 'failure',
          error: 'StripeConnectionError',
          result: 'failed',
          reason: 'stripe_unavailable',
          owner: 'dependency',
          type: 'subscription',
          shipping: 'none',
          phone: 'none',
        },
      ]);
    });

    it('responds with 200 and does nothing for a payment checkout that is neither a gift nor a donation, such as a Payment Link sale', async function () {
      const status = await send('checkout.session.completed', {
        id: stripeId('cs'),
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        customer: null,
        metadata: {},
      });

      assert.equal(status, 200);
      assert.deepEqual(spansOf(metrics, 'stripe_checkout.complete'), [
        { outcome: 'success', shipping: 'none', phone: 'none' },
      ]);
    });

    it('responds with 200 and does nothing for a checkout marked as both a gift and a donation', async function () {
      const status = await send('checkout.session.completed', {
        id: stripeId('cs'),
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        customer: null,
        metadata: { ghost_donation: 'true', ghost_gift: 'true' },
      });

      assert.equal(status, 200);
      assert.deepEqual(spansOf(metrics, 'stripe_checkout.complete'), [
        { outcome: 'success', shipping: 'none', phone: 'none' },
      ]);
    });

    it('responds with 200 and does nothing for a card update when no member has the Stripe customer', async function () {
      const setupIntent = {
        id: stripeId('seti'),
        object: 'setup_intent',
        payment_method: stripeId('pm'),
        metadata: { customer_id: stripeId('cus') },
      };
      stripeAnswersWith('GET', `/v1/setup_intents/${setupIntent.id}`, [200, setupIntent]);

      const status = await send('checkout.session.completed', {
        id: stripeId('cs'),
        object: 'checkout.session',
        mode: 'setup',
        customer: setupIntent.metadata.customer_id,
        setup_intent: setupIntent.id,
        metadata: {},
      });

      assert.equal(status, 200);
      assert.deepEqual(spansOf(metrics, 'stripe_checkout.complete'), [
        { outcome: 'success', type: 'setup', shipping: 'none', phone: 'none' },
      ]);
    });

    it('responds with 200 and does nothing when an asynchronous payment fails', async function () {
      const status = await send('checkout.session.async_payment_failed', {
        id: stripeId('cs'),
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'unpaid',
        metadata: { ghost_gift_id: 'gift_123' },
      });

      assert.equal(status, 200);
      assert.deepEqual(spansOf(metrics, 'stripe_checkout.complete'), [
        { outcome: 'success', shipping: 'none', phone: 'none' },
      ]);
    });
  });

  describe('customer.subscription.updated', function () {
    it('responds with 200 and does nothing when no member has the subscription’s Stripe customer', async function () {
      const status = await send('customer.subscription.updated', subscriptionFor(stripeId('cus')));

      assert.equal(status, 200);
      assert.deepEqual(spansOf(metrics, 'stripe.webhook'), [
        {
          outcome: 'success',
          type: 'customer.subscription.updated',
          kind: 'subscription',
          result: 'handled',
        },
      ]);
    });

    it('responds with 400 on every attempt when the subscription’s Stripe coupon isn’t a valid offer', async function () {
      const coupon = {
        id: stripeId('coupon'),
        object: 'coupon',
        amount_off: null,
        currency: 'usd',
        duration: 'forever',
        duration_in_months: null,
        name: '12.5% off',
        percent_off: 12.5,
        valid: true,
      };
      const subscription = subscriptionFor(FIXTURE_CUSTOMER, {
        discount: {
          id: stripeId('di'),
          object: 'discount',
          coupon,
          customer: FIXTURE_CUSTOMER,
          start: Math.floor(Date.now() / 1000),
        },
      });
      stripeAnswersWith('GET', `/v1/subscriptions/${subscription.id}`, [200, subscription]);
      stripeAnswersWith('GET', `/v1/customers/${FIXTURE_CUSTOMER}`, [
        200,
        {
          id: FIXTURE_CUSTOMER,
          object: 'customer',
          email: 'paid@test.com',
          subscriptions: { object: 'list', data: [subscription] },
        },
      ]);

      const status = await send('customer.subscription.updated', subscription);

      assert.equal(status, 400);
      assert.deepEqual(spansOf(metrics, 'stripe.webhook'), [
        {
          outcome: 'failure',
          error: 'ValidationError',
          type: 'customer.subscription.updated',
          kind: 'subscription',
          result: 'failed',
          reason: 'unclassified',
          owner: 'ghost',
        },
      ]);
    });

    it('responds with 400 on every attempt to a subscription with more than one price, such as one created in the Stripe dashboard', async function () {
      const items = [
        { id: stripeId('si'), price: { id: 'price_a', product: FIXTURE_PRODUCT } },
        { id: stripeId('si'), price: { id: 'price_b', product: FIXTURE_PRODUCT } },
      ];

      const status = await send(
        'customer.subscription.updated',
        subscriptionFor(FIXTURE_CUSTOMER, { items }),
      );

      assert.equal(status, 400);
      assert.deepEqual(spansOf(metrics, 'stripe.webhook'), [
        {
          outcome: 'failure',
          error: 'STRIPE_WEBHOOK_UNSUPPORTED_SUBSCRIPTION',
          type: 'customer.subscription.updated',
          kind: 'subscription',
          result: 'failed',
          reason: 'unsupported_subscription',
          owner: 'site',
        },
      ]);
    });
  });

  describe('invoice.payment_succeeded', function () {
    function invoiceFor(subscription) {
      return {
        id: stripeId('in'),
        object: 'invoice',
        customer: subscription.customer,
        subscription: subscription.id,
        paid: true,
        amount_paid: 500,
        currency: 'usd',
      };
    }

    async function paymentsOf(customerId) {
      const member = await models.Member.findOne({
        id: (await db.knex('members_stripe_customers').where({ customer_id: customerId }).first())
          .member_id,
      });
      return await db.knex('members_payment_events').where({ member_id: member.id });
    }

    it('records the payment for a member’s invoice', async function () {
      const subscription = subscriptionFor(FIXTURE_CUSTOMER);
      stripeAnswersWith('GET', `/v1/subscriptions/${subscription.id}`, [200, subscription]);
      const before = (await paymentsOf(FIXTURE_CUSTOMER)).length;

      const status = await send('invoice.payment_succeeded', invoiceFor(subscription));

      assert.equal(status, 200);
      assert.equal((await paymentsOf(FIXTURE_CUSTOMER)).length, before + 1);
    });

    it('responds with 200 and records nothing for an invoice without a subscription, such as a donation’s invoice', async function () {
      const status = await send('invoice.payment_succeeded', {
        id: stripeId('in'),
        object: 'invoice',
        customer: stripeId('cus'),
        subscription: null,
        paid: true,
        amount_paid: 500,
        currency: 'usd',
      });

      assert.equal(status, 200);
      assert.deepEqual(spansOf(metrics, 'stripe.webhook'), [
        {
          outcome: 'success',
          type: 'invoice.payment_succeeded',
          kind: 'invoice',
          result: 'handled',
        },
      ]);
    });

    it('responds with 200 and records nothing for an invoice for a product that is not one of the site’s tiers', async function () {
      const subscription = subscriptionFor(stripeId('cus'), { product: 'prod_of_another_site' });
      stripeAnswersWith('GET', `/v1/subscriptions/${subscription.id}`, [200, subscription]);

      const status = await send('invoice.payment_succeeded', invoiceFor(subscription));

      assert.equal(status, 200);
    });

    it('responds with 200 and records nothing for an invoice whose subscription has more than one price', async function () {
      const subscription = subscriptionFor(stripeId('cus'), {
        items: [
          { id: stripeId('si'), price: { id: 'price_a', product: FIXTURE_PRODUCT } },
          { id: stripeId('si'), price: { id: 'price_b', product: FIXTURE_PRODUCT } },
        ],
      });
      stripeAnswersWith('GET', `/v1/subscriptions/${subscription.id}`, [200, subscription]);

      const status = await send('invoice.payment_succeeded', invoiceFor(subscription));

      assert.equal(status, 200);
    });

    it('responds with 404 on every attempt to an invoice for one of the site’s tiers when no member has the Stripe customer', async function () {
      const subscription = subscriptionFor(stripeId('cus'));
      stripeAnswersWith('GET', `/v1/subscriptions/${subscription.id}`, [200, subscription]);

      const status = await send('invoice.payment_succeeded', invoiceFor(subscription));

      assert.equal(status, 404);
      assert.deepEqual(spansOf(metrics, 'stripe.webhook'), [
        {
          outcome: 'failure',
          error: 'STRIPE_WEBHOOK_NO_MEMBER_FOR_CUSTOMER',
          type: 'invoice.payment_succeeded',
          kind: 'invoice',
          result: 'failed',
          reason: 'no_member_for_customer',
          owner: 'site',
        },
      ]);
    });

    it('responds with 401 when the publisher has revoked Ghost’s access to their Stripe account', async function () {
      const subscription = subscriptionFor(FIXTURE_CUSTOMER);
      stripeAnswersWith('GET', `/v1/subscriptions/${subscription.id}`, STRIPE.accessRevoked);

      const status = await send('invoice.payment_succeeded', invoiceFor(subscription));

      assert.equal(status, 401);
      assert.deepEqual(spansOf(metrics, 'stripe.webhook'), [
        {
          outcome: 'failure',
          error: 'platform_api_key_expired',
          kind: 'invoice',
          result: 'failed',
          reason: 'stripe_access_revoked',
          owner: 'site',
          type: 'invoice.payment_succeeded',
        },
      ]);
    });
  });

  describe('charge.refunded', function () {
    it('responds with 200 and does nothing for a refund that is not for a gift', async function () {
      const status = await send('charge.refunded', {
        id: stripeId('ch'),
        object: 'charge',
        payment_intent: stripeId('pi'),
        refunded: true,
      });

      assert.equal(status, 200);
      assert.deepEqual(spansOf(metrics, 'stripe.webhook'), [
        { outcome: 'success', type: 'charge.refunded', kind: 'refund', result: 'handled' },
      ]);
    });
  });
});

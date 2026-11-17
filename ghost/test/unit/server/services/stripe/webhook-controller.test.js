const sinon = require('sinon');
const Stripe = require('stripe');
const logging = require('@tryghost/logging');
const {
  WebhookController,
} = require('../../../../../core/server/services/stripe/webhook-controller');
const { createTracer } = require('../../../../../core/server/lib/tracing/create-tracer');
const { createMeter } = require('../../../../../core/server/lib/tracing/create-meter');
const { stripeTracking } = require('../../../../../core/server/services/stripe/tracking');

const shipNothing = { transport: { metric: async () => null }, logging: { error() {} } };
const tracking = stripeTracking({
  tracer: createTracer(shipNothing),
  meter: createMeter(shipNothing),
});

// What the end-to-end tests in `stripe-webhook-outcomes.test.js` can't see: which failures go to
// Sentry, and the log line for an event at another Stripe API version.
describe('WebhookController', function () {
  let controller;
  let deps;
  let req;
  let res;

  beforeEach(function () {
    deps = {
      apiVersion: '2020-08-27',
      subscriptionEventService: { handleSubscriptionEvent: sinon.stub() },
      invoiceEventService: { handleInvoiceEvent: sinon.stub() },
      checkoutSessionEventService: { handleEvent: sinon.stub(), handleDonationEvent: sinon.stub() },
      chargeRefundedEventService: { handleEvent: sinon.stub() },
      webhookManager: { webhookSecret: 'whsec_test', parseWebhook: sinon.stub() },
      tracking,
      sentry: { captureException: sinon.stub() },
    };

    controller = new WebhookController(deps);

    req = {
      body: {},
      headers: {
        'stripe-signature': 'valid-signature',
      },
    };

    res = {
      writeHead: sinon.stub(),
      end: sinon.stub(),
    };
  });

  afterEach(function () {
    sinon.restore();
  });

  it('logs an error for an event rendered at a different API version and still handles it', async function () {
    sinon.stub(logging, 'error');
    deps.webhookManager.parseWebhook.returns({
      type: 'charge.refunded',
      api_version: '2025-08-27.basil',
      data: { object: { id: 'ch_1' } },
    });

    await controller.handle(req, res);

    sinon.assert.calledWithMatch(logging.error, {
      event: { name: 'stripe.webhook.api_version_mismatch' },
      api_version: '2025-08-27.basil',
      expected_api_version: '2020-08-27',
    });
    sinon.assert.calledOnce(deps.chargeRefundedEventService.handleEvent);
    sinon.assert.calledWith(res.writeHead, 200);
  });

  it('does not log a version error for an event at the pinned API version', async function () {
    sinon.stub(logging, 'error');
    deps.webhookManager.parseWebhook.returns({
      type: 'charge.refunded',
      api_version: '2020-08-27',
      data: { object: { id: 'ch_1' } },
    });

    await controller.handle(req, res);

    sinon.assert.notCalled(logging.error);
  });

  it('reports an event it failed to handle to Sentry', async function () {
    const failure = new Error('Unexpected error');
    deps.webhookManager.parseWebhook.returns({
      type: 'customer.subscription.created',
      data: { object: { customer: 'cust_123' } },
    });
    deps.subscriptionEventService.handleSubscriptionEvent.throws(failure);

    await controller.handle(req, res);

    sinon.assert.calledOnceWithExactly(deps.sentry.captureException, failure);
  });

  it('doesn’t report an event that failed because Ghost lost access to the Stripe account', async function () {
    deps.webhookManager.parseWebhook.returns({
      type: 'customer.subscription.created',
      data: { object: { customer: 'cust_123' } },
    });

    for (const failure of [
      new Stripe.errors.StripeAuthenticationError({
        message: 'Expired API Key provided',
        code: 'platform_api_key_expired',
        statusCode: 401,
      }),
      new Stripe.errors.StripePermissionError({
        message: 'The provided key does not have the required permissions',
        statusCode: 403,
      }),
    ]) {
      deps.subscriptionEventService.handleSubscriptionEvent.throws(failure);
      await controller.handle(req, res);
      sinon.assert.calledWith(res.writeHead, failure.statusCode);
    }

    sinon.assert.notCalled(deps.sentry.captureException);
  });

  it('reports an event that failed because Stripe refused a request Ghost made', async function () {
    const failure = new Stripe.errors.StripeInvalidRequestError({
      message: 'Must provide customer or customer_account.',
      statusCode: 400,
    });
    deps.webhookManager.parseWebhook.returns({
      type: 'customer.subscription.created',
      data: { object: { customer: 'cust_123' } },
    });
    deps.subscriptionEventService.handleSubscriptionEvent.throws(failure);

    await controller.handle(req, res);

    sinon.assert.calledOnceWithExactly(res.writeHead, 400);
    sinon.assert.calledOnceWithExactly(deps.sentry.captureException, failure);
  });
});

import Fastify from "fastify";
import "dotenv/config";

import pkg from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);


const { PrismaClient } = pkg;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter
});

const app = Fastify({ logger: true });

// app.addContentTypeParser("*", { parseAs: "buffer" }, (req, body, done) => {
//     req.rawBody = body;
//     done(null, body);
//   });

import rawBody from "fastify-raw-body";

await app.register(rawBody, {
  field: "rawBody",
  global: false,
  encoding: "utf8",
  runFirst: true
});

  

app.get("/health", async () => {
  return { status: "ok" };
});

app.post("/products", async (req) => {
  const { name, price } = req.body;
  return prisma.product.create({
    data: { name, price }
  });
});

app.get("/products", async () => {
  return prisma.product.findMany();
});

app.listen({ port: 3000 });

app.post("/orders", async (req) => {
    const { productId } = req.body;
  
    return prisma.order.create({
      data: {
        productId,
        status: "PENDING"
      }
    });
  });
  
  app.get("/orders", async () => {
    return prisma.order.findMany({
      include: { product: true }
    });
  });
  
  app.post("/pay", async (req) => {
    const { orderId } = req.body;
  
    // 1. Load the order
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { product: true }
    });
  
    if (!order) {
      return { error: "Order not found" };
    }
  
    // 2. If payment intent already exists, reuse it
    if (order.stripePaymentIntentId) {
      const existingIntent = await stripe.paymentIntents.retrieve(
        order.stripePaymentIntentId
      );
  
      return {
        clientSecret: existingIntent.client_secret
      };
    }
  
    // 3. Otherwise create a new PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: order.product.price * 100,
      currency: "inr",
      payment_method_types: ["card"]
    });
  
    // 4. Store Stripe ID in DB
    await prisma.order.update({
      where: { id: orderId },
      data: {
        stripePaymentIntentId: paymentIntent.id
      }
    });
  
    // 5. Return client secret
    return {
      clientSecret: paymentIntent.client_secret
    };
  });
  
  
  app.post("/webhook", {
    config: {
      rawBody: true
    }
  }, async (req, reply) => {
    const sig = req.headers["stripe-signature"];
  
    const body = req.rawBody;
  
    let event;
  
    try {
      event = stripe.webhooks.constructEvent(
        body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("Webhook signature failed:", err.message);
      return reply.status(400).send("Bad signature");
    }
  
    console.log("Stripe event:", event.type);
  
    if (event.type === "payment_intent.succeeded") {
        await processPaymentEvent(event);
        return { received: true };
      }
      
    });
  app.post("/confirm", async (req) => {
    const { paymentIntentId } = req.body;
  
    const confirmed = await stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method: "pm_card_visa"
    });
  
    return confirmed;
  });
  

  async function processPaymentEvent(event) {

    const eventId = event.id;
const eventType = event.type;

const existingEvent = await prisma.processedEvent.findUnique({
  where: { eventId }
});

if (existingEvent?.status === "COMPLETED") {
  console.log("Event already processed:", eventId);
  return;
}

if (!existingEvent) {
  await prisma.processedEvent.create({
    data: {
      eventId,
      eventType,
      status: "STARTED"
    }
  });
}


    

    const paymentIntent = event.data.object;
  const stripeId = paymentIntent.id;

  const order = await prisma.order.findFirst({
    where: { stripePaymentIntentId: stripeId }
  });

  if (!order) {
    console.log("No order found for Stripe ID:", stripeId);
    return;
  }

  if (order.status === "PAID") {
    // IMPORTANT: do nothing
    console.log("Order already PAID:", order.id);
    return;
  }

  await prisma.orderEvent.create({
    data: {
      orderId: order.id,
      eventType: "PAYMENT_CONFIRMED",
      source: "WEBHOOK",
      referenceId: event.id,
      metadata: {
        stripePaymentIntentId: paymentIntent.id,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency
      }
    }
  });

  await prisma.order.update({
    where: { id: order.id },
    data: { status: "PAID" }
  });

  console.log("Order marked PAID:", order.id);

  await prisma.processedEvent.update({
    where: { eventId },
    data: { status: "COMPLETED" }
  });
}
  
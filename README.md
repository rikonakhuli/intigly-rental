# Rental Map: Razorpay setup (test mode)

The listing fee (₹1,000, or ₹1,500 for 1.5 BHK and above) is paid through Razorpay Checkout.js. The prototype runs in test mode, so no real money moves.

Files:
- index.html, styles.css, app.js, data.js: the app (the checkout step is the "Pay to publish" view inside index.html).
- config.js: browser-side settings. Holds only the public key_id.
- server.js: a small Node server (no npm packages). It serves the app and creates orders and verifies payments. Its key_secret stays on the server.

## 1. Create a free Razorpay account

1. Go to https://dashboard.razorpay.com/signup and sign up with the business email you want to use for Intigly.
2. You can start in test mode immediately after signup. Test mode needs no KYC and no money.

## 2. Complete KYC (required before live mode, optional for test)

In the Razorpay dashboard, open Account and Settings, then Business details. Enter the details for Intigly Private Limited:
- Legal business name: Intigly Private Limited
- Business type: Private Limited
- Business address: the registered office address of Intigly (HSR Layout, Bangalore)
- Business PAN, company CIN, GST number (if registered), and bank account in the company's name
- Authorized signatory details

Submit the KYC. Live payments stay disabled until Razorpay approves it. Test mode keeps working in the meantime.

## 3. Get test keys

1. In the dashboard, switch the toggle to Test Mode (top left).
2. Go to Account and Settings, then API Keys, and click Generate Test Key.
3. Copy the key_id (starts with rzp_test_) and the key_secret. The key_secret is shown only once, so save it now.

## 4. Paste the keys

Paste the key_id into config.js:

    window.RAZORPAY_CONFIG = {
      key_id: "rzp_test_xxxxxxxxxxxx",   // public, safe in the browser
      ...
    };

Do NOT paste the key_secret into config.js. The browser can read that file. Put the key_secret in an environment variable for the server only:

    export RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
    export RAZORPAY_KEY_SECRET=your_test_secret

## 5. Run it

You need Node 18 or newer.

    cd rental_app
    node server.js

Open http://localhost:3000 in your browser. Do not open index.html directly from disk. The payment routes need server.js.

Test card for the Razorpay checkout modal: 4111 1111 1111 1111, any future expiry, any CVV. Use any OTP the test mode asks for (test mode accepts the defaults shown in the modal).

## 6. Going live later

1. Wait for Razorpay to approve the KYC. Then in the dashboard, switch to Live Mode and generate a live key pair.
2. In config.js, set key_id to your rzp_live_ key.
3. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to the live values before starting server.js.
4. Before real customers pay, replace the in-memory order store in server.js (ORDERS is a Map, so pending orders are lost on restart) with a database.
5. Put the server behind HTTPS. Razorpay Checkout requires it in production.
6. Run one real payment of the fee amount on your own card, then confirm it shows as captured in the Razorpay dashboard before opening the app to users. Refund it from the dashboard if you do not want to keep it.

## Notes

- The server sets the fee, not the browser. A 1 BHK order is always ₹1,000, and a 1.5 BHK or larger order is ₹1,500.
- A listing goes on the map only after server.js confirms the Razorpay signature and that the payment is captured or authorized for the exact amount.
- Photos and videos are stored only in the browser session, so a page reload loses them. Listing metadata is kept in localStorage.

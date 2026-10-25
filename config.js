// Browser-side Razorpay settings. Safe to commit: key_id is public by design.
// Paste your TEST key_id here (starts with rzp_test_). Go live later by swapping in rzp_live_ (see README).
//
// key_secret is NOT here. It must never reach the browser. It lives in the server
// environment variable RAZORPAY_KEY_SECRET (see README).
window.RAZORPAY_CONFIG = {
  key_id: "rzp_test_REPLACE_WITH_YOUR_KEY_ID",
  business_name: "Intigly Private Limited",
  create_order_url: "/api/create-order",
  verify_url: "/api/verify-payment"
};

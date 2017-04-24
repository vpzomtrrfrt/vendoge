var pg = require('pg');
var connect = require('connect');
var bodyParser = require('body-parser');
var serveStatic = require('serve-static');
var Q = require('q');
var hat = require('hat');
var payments = new (require('coinpayments'))({
	key: process.env.CONSUMER_KEY,
	secret: process.env.CONSUMER_SECRET
});
var https = require('https');

var COST = 200;

function parseDBURL(uri) {
	var params = require('url').parse(uri);
	var auth = params.auth.split(":");
	return {
		user: auth[0],
		password: auth[1],
		host: params.hostname,
		port: params.port || 5432,
		database: params.pathname.split('/')[1]
	};
}

var options = parseDBURL(process.env.DATABASE_URL);
console.log(options);
var db = new pg.Pool(options);
var app = connect();

app.use(serveStatic("static"));

app.use(bodyParser.urlencoded({}));

app.use("/buy", function(req, res, next) {
	var amount = parseInt(req.body.amount || 1);
	var amount2 = parseInt(req.body.amount2 || 0);
	if(amount < 0 || amount2 < 0) {
		throw "Negative values are not allowed.";
	}
	if(amount+amount2 < 1) {
		throw "You can't buy nothing!";
	}
	Q.ninvoke(payments, "createTransaction", {
		currency1: 'DOGE',
		currency2: 'DOGE',
		amount: COST*(amount+amount2),
		buyer_email: req.body.email
	})
		.then(function(trans) {
			var id = hat(16, 4);
			return db.connect()
				.then(function(client) {
					return client.query("INSERT INTO payments (timestamp, id, coinpayments_id, amount, amount2) VALUES (localtimestamp, $1, $2, $3, $4)", [id, trans.txn_id, amount, amount2])
						.then(function(result) {
							client.release();
						}, function(err) {
							client.release();
							throw err;
						})
						.then(function() {
							res.writeHead(200, {"Content-type": "text/html"});
							res.write("<!DOCTYPE html><html><head><title>Payment link stuff</title></head><body>");
							res.write('<a href="'+trans.status_url+'" target="_blank">Link</a>');
							res.write('<br/><img src="'+trans.qrcode_url+'" />');
							res.write('<br/>Code: '+id);
							res.write('</body></html>');
							res.end();
						});
				});
		})
		.catch(function(err) {
			console.error(err);
			next(err);
		});
});

app.use("/redeem", function(req, res, next) {
	var spl = req.url.split("/");
	if(spl.length != 2) {
		next();
	}
	else {
		db.connect()
			.then(function(client) {
				return client.query("SELECT coinpayments_id, amount, amount2 FROM payments WHERE id = $1", [spl[1]])
					.then(function(result) {
						if(result.rows.length < 1) {
							throw "Invalid code";
						}
						var amount = result.rows[0].amount;
						var amount2 = result.rows[0].amount2;
						var cost = COST*(amount+amount2);
						return Q.ninvoke(payments, "getTx", result.rows[0].coinpayments_id)
							.then(function(trans) {
								if(trans.status >= 100) {
									return "coinpayments says yes";
								}
								return new Promise(function(resolve, reject) {
									https.get("https://chain.so/api/v2/get_address_balance/DOGE/"+trans.payment_address, function(res) {
										console.log("res achieved");
										if(res.statusCode !== 200) {
											reject(trans.status_text);
											return;
										}
										var data = "";
										res.on('data', function(chunk) {
											data += chunk;
										});
										res.on('end', function() {
											console.log("end");
											var j = JSON.parse(data);
											if(j.status != "success") {
												reject(trans.status_text);
												console.error(j);
												return;
											}
											if(parseFloat(j.data.confirmed_balance) == cost) {
												resolve("chain.so says yes");
												return;
											}
											reject(trans.status_text);
											console.error(j);
										});
										res.on('error', reject);
									});
								});
							})
							.then(function() {
								return client.query("DELETE FROM payments WHERE id = $1", [spl[1]])
									.then(function() {
										res.end(amount+","+amount2);
									});
							}, function(err) {
								res.writeHead(403, {"Content-type": "text/plain"});
								res.end(err+"");
								console.error(err);
							});
					});
			}, function(err) {
				client.release();
				throw err;
			})
			.catch(function(e) {
				res.writeHead(403, {"Content-type": "text/plain"});
				res.end(e+"");
				console.error(e);
			});
	}
});

app.listen(process.env.PORT || 9000);

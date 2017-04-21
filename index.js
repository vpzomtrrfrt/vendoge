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
	Q.ninvoke(payments, "createTransaction", {
		currency1: 'DOGE',
		currency2: 'DOGE',
		amount: 20,
		buyer_email: req.body.email
	})
	.then(function(trans) {
		var id = hat(16, 4);
		return db.connect()
		.then(function(client) {
			return client.query("INSERT INTO payments (timestamp, id, coinpayments_id) VALUES (localtimestamp, $1, $2)", [id, trans.txn_id])
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
			return client.query("SELECT coinpayments_id FROM payments WHERE id = $1", [spl[1]])
			.then(function(result) {
				client.release();
				if(result.rows.length < 1) {
					throw "No such ID";
				}
				Q.ninvoke(payments, "getTx", result.rows[0].coinpayments_id)
					.then(function(trans) {
						if(trans.status < 100) {
							res.writeHead(403, {"Content-type": "text/plain"});
							res.end(trans.status_text);
						}
						else {
							res.end("OK");
						}
					});
			}, function(err) {
				client.release();
				throw err;
			});
		});
	}
});

app.listen(process.env.PORT || 9000);

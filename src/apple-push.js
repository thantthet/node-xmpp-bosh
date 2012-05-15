var bosh      = require('./bosh.js');
var http      = require('http');
var url       = require('url');
var path      = require('path');
var EventPipe = require('eventpipe').EventPipe;
var ltx       = require('ltx');
var apns      = require('apn');

var filename  = "[" + path.basename(path.normalize(__filename)) + "]";
var logger    = require('./log.js');
var log       = logger.getLogger(filename);

function APNProvider(bosh_server) {

    this.sessions = [ ];

    this.config = {
        register_path : /^\/register(\/+)?$/,
        unregister_path : /^\/unregister(\/+)?$/,
        port : 2020,
        address : '0.0.0.0'
    };

    function http_error_handler(ex) {
        throw new Error(
            sprintf('ERROR on listener at endpoint: http://%s:%s%s',
                options.host, options.port, options.path)
        );
    }

    function handle_register_request(req, res, u) {
        var ppos = u.pathname.search(this.config.register_path);
        if (ppos === -1) {
            return;
        }

        var req_parts = '';

        var on_end = function() {
            var req = {};
            var invalid_req = function () {
                res.end('Invalid request.');
            };

            try {
                req = JSON.parse(req_parts);
            } catch(e) {
                log.error("Exception : %s, while parsing %s", e, req_parts);
                invalid_req();
                return false;
            }

            if (typeof req.sid === 'undefined') {
                invalid_req();
                return false;
            }

            if (this._add_sid(req.sid, req)) {
                res.end('Registered');
            } else {
                invalid_req();
                return false;
            }
        }.bind(this);

        req.on('data', function (d) {
            req_parts += d.toString();
        })
        .on('end', function () {
            on_end();
        });

        return false;
    }

    function handle_unregister_request(req, res, u) {
        var ppos = u.pathname.search(this.config.unregister_path);
        if (ppos === -1) {
            return;
        }

        var req_parts = '';

        var on_end = function() {
            var req = {};
            var invalid_req = function () {
                res.end('Invalid request.');
            };

            try {
                req = JSON.parse(req_parts);
            } catch(e) {
                log.error("Exception : %s, while parsing %s", e, req_parts);
                invalid_req();
                return;
            }

            if (typeof req.sid === 'undefined') {
                invalid_req();
                return;
            }

            this._remove_sid(req.sid);
            res.end('Unregistered');
        }.bind(this);

        req.on('data', function (d) {
            req_parts += d.toString();
        })
        .on('end', function () {
            on_end();
        });

        return false;
    }

    function handle_unhandled_request(req, res, u) {
        if (u.pathname === '/') {
            res.write('<html>')
            res.write('<title>APN Provider</title>')
            res.write('<body>');

            for (var session in this.sessions) {
                res.write('<p>');
                res.write(JSON.stringify(this.sessions[session]));
                res.write('</p>');
            }

            res.write('</body>');
            res.write('</html>');
        }
        res.end();
        return false;
    }

    bosh_server.on("response", function(stanza, stream) {
        this.response_received(stanza, stream);
    }.bind(this));

    bosh_server.on("terminate", function(stream, error) {
        this.stream_terminated(stream);
    }.bind(this));

    bosh_server.on("stream-terminate", function(stream) {
        this.stream_terminated(stream);
    }.bind(this));

    var router = new EventPipe();
    router.on('request', handle_register_request.bind(this), 1)
        .on('request', handle_unregister_request.bind(this), 2)
        .on('request', handle_unhandled_request.bind(this), 3)

    function http_request_handler(req, res) {
        var u = url.parse(req.url, true);
        log.trace("Processing %s request at location: %s", req.method, u.pathname);
        router.emit('request', req, res, u);
    }

    var server = http.createServer(http_request_handler);
    server.on('error', http_error_handler);

    var address = this.config.address;
    var port = this.config.port;

    server.listen(port, address);

    log.trace("APNS notifier server on : http://%s:%s", address, port);
}

APNProvider.prototype = {
    _add_sid : function (sid, info) {
        log.trace('Adding sid : %s', JSON.stringify(info));
        if (info['device-token']) {
            this.sessions[sid] = info;
            added = true;
        } else {
            log.trace('No device-token');
            added = false;
        }
        return added;
    },

    _remove_sid: function (sid) {
        log.trace('Removing sid: %s', sid)
        delete this.sessions[sid];
    },

    response_received : function (stanza, stream) {
        if (typeof this.sessions[stream.state.sid] !== 'undefined') {
            var info = this.sessions[stream.state.sid];
            // if message stanza
            if (stanza.is('message')) {
                // with body
                var body = stanza.getChild('body');
                if (body) {
                    log.trace("Should notify message: %s", body.t());
                    return;
                    var dest_device = new apns.Device(info['device-token']);

                    var options = {
                        cert: 'cert.pem',                 /* Certificate file */
                        certData: null,                   /* Optional: if supplied uses this instead of Certificate File */
                        key:  'key.pem',                  /* Key file */
                        keyData: null,                    /* Optional: if supplied uses this instead of Key file */
                        passphrase: null,                 /* Optional: A passphrase for the Key file */
                        gateway: 'gateway.push.apple.com',/* gateway address */
                        port: 2195,                       /* gateway port */
                        enhanced: true,                   /* enable enhanced format */
                        errorCallback: undefined,         /* Callback when error occurs */
                        cacheLength: 5                    /* Number of notifications to cache for error purposes */
                    };

                    var apnsConnection = new apns.Connection(options);

                    var message = new apns.Notification();

                    message.badge = 1;
                    message.sound = "ping.aiff";
                    message.alert = body.t();
                    message.device = dest_device;

                    apnsConnection.sendNotification(message);
                }
            }
        }
    },

    stream_terminated : function (stream) {
        if (typeof this.sessions[stream.state.sid] !== 'undefined') {
            this._remove_sid(stream.state.sid);
        }
    }
}

exports.APNProvider = APNProvider;
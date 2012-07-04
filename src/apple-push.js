var bosh      = require('./bosh.js');
var opt       = require('./options.js');
var http      = require('http');
var url       = require('url');
var path      = require('path');
var EventPipe = require('eventpipe').EventPipe;
var ltx       = require('ltx');
var apns      = require('apn');
var Buffer    = require('buffer').Buffer;

var filename  = "[" + path.basename(path.normalize(__filename)) + "]";
var logger    = require('./log.js');
var log       = logger.getLogger(filename);

function APNProvider(bosh_server, options) {

    var bosh_options;
    
    this.sessions = [ ];
    this.devices = {};

    var config = {
        register_path : /^\/register(\/+)?$/,
        unregister_path : /^\/unregister(\/+)?$/,
        set_badge_path : /^\/set-badge(\/+)?$/,
        port : 2020,
        address : '0.0.0.0'
    };

    function http_error_handler(ex) {
        throw new Error(
            sprintf('ERROR on listener at endpoint: http://%s:%s%s',
                config.address, config.port)
        );
    }
    
    function handle_set_badge_request(req, res, u) {
        var ppos = u.pathname.search(config.set_badge_path);
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
            
            this._set_badge(req);
        }.bind(this);

        req.on('data', function (d) {
            req_parts += d.toString();
        })
        .on('end', function () {
            on_end();
        });

        return false;
    }

    function handle_register_request(req, res, u) {
        var ppos = u.pathname.search(config.register_path);
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
        var ppos = u.pathname.search(config.unregister_path);
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
            res.writeHead(200, bosh_options.HTTP_GET_RESPONSE_HEADERS);
            var html = [ ];
            html.push('<?xml version="1.0" encoding="utf-8"?>');
            html.push('<!DOCTYPE html>');
            html.push('<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">')
            html.push('<title>APN Provider</title>')
            html.push('<body>');

            for (var session in this.sessions) {
                html.push('<p>');
                html.push(JSON.stringify(this.sessions[session]));
                html.push('</p>');
            }

            html.push('</body>');
            html.push('</html>');
            
            res.write(html.join('\n'));
        }
        res.end();
        return false;
    }
    
    bosh_options = new opt.BOSH_Options(options);

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
        .on('request', handle_set_badge_request.bind(this), 3)
        .on('request', handle_unhandled_request.bind(this), 4)

    function http_request_handler(req, res) {
        var u = url.parse(req.url, true);
        log.debug("Processing %s request at location: %s", req.method, u.pathname);
        router.emit('request', req, res, u);
    }

    var server = http.createServer(http_request_handler);
    server.on('error', http_error_handler);

    var address = config.address;
    var port = config.port;

    server.listen(port, address);

    console.log("APNS notifier server on : http://%s:%s", address, port);
}

APNProvider.prototype = {
    _add_sid : function (sid, info) {
        log.debug('Adding sid : %s', JSON.stringify(info));
        var token = info['device-token'];
        if (token) {
            this.sessions[sid] = info;
            added = true;

            if (this.devices[token]) {
                var previous_sid = this.devices[token];
                this._remove_sid(previous_sid);
            }

            this.devices[token] = sid;

        } else {
            log.debug('No device-token');
            added = false;
        }

        return added;
    },

    _remove_sid: function (sid) {
        log.debug('Removing sid: %s', sid)
        delete this.sessions[sid];
    },
    
    _set_badge: function(info) {
        var session = this.sessions[info.sid];
        if (session) {
            var message = {
                badge: info.badge
            }
            this.pushNote(session['device-token'], message);
        }
    },

    response_received : function (stanza, stream) {
        if (typeof this.sessions[stream.state.sid] !== 'undefined') {
            var info = this.sessions[stream.state.sid];
            // if message stanza
            if (stanza.is('message')) {
                // with body
                var body = stanza.getChild('body');
                if (body) {
                    log.debug("Should notify message: %s", body.text());
                    
                    var message_count = 0;

                    stream.session.pending_stanzas[stream.name].forEach(function (stanza) {
                        if (stanza.is('message') && stanza.getChild('body')) {
                            message_count++;
                        }
                    });
                    
                    var jid = stanza.attr('from').split('/')[0];
                    
                    var message = {
                        alert: jid + ': ' + body.text(),
                        badge: message_count,
                        payload: {
                            from: stanza.attr('from'),
                            to: stanza.attr('to')
                        }
                    };
                    this.pushNote(info['device-token'], message);
                }
            }
        }
    },
    
    pushNote: function(token, aMessage) {
        log.debug('Pushing a note')
        var dest_device = new apns.Device(token);
        
        var production = false;     /* Set true if production env */ 
        
        var cert = __dirname + '/../' + (production ? 'apns-pro-cert.pem' : 'apns-dev-cert.pem');
        var key = __dirname + '/../' + (production ? 'apns-pro-key.pem' : 'apns-dev-key.pem');
        var gateway = production ? 'gateway.push.apple.com' : 'gateway.sandbox.push.apple.com';

        var options = {
            cert: cert,                             /* Certificate file */
            certData: null,                         /* Optional: if supplied uses this instead of Certificate File */
            key: key,                               /* Key file */
            keyData: null,                          /* Optional: if supplied uses this instead of Key file */
            passphrase: null,                       /* Optional: A passphrase for the Key file */
            gateway: gateway,                       /* gateway address */
            port: 2195,                             /* gateway port */
            enhanced: true,                         /* enable enhanced format */
            errorCallback: function(code, note) {
                log.debug("Failed to send push: code = %i", code);
                },                                  /* Callback when error occurs */
            cacheLength: 5                          /* Number of notifications to cache for error purposes */
        };

        var apnsConnection = new apns.Connection(options);

        var message = new apns.Notification();
        
        message.badge = aMessage.badge;
        message.sound = "new_message_tone.caf";     /* set sound file name */
        message.payload = aMessage.payload;
        message.alert = aMessage.alert;
        message.device = dest_device;
        
        payloadLength = Buffer.byteLength(JSON.stringify(message), 'utf8');
        if (payloadLength > 256) {
            reduceLength = payloadLength - 256;
            buffer = new Buffer(aMessage.alert, 'utf8');
            message.alert = buffer.toString('utf8', 0, buffer.length - reduceLength);
        }

        var ret = apnsConnection.sendNotification(message);
        log.debug("Push sent: %d", ret);
    },

    stream_terminated : function (stream) {
        if (typeof this.sessions[stream.state.sid] !== 'undefined') {
            this._remove_sid(stream.state.sid);
        }
    }
}

exports.APNProvider = APNProvider;
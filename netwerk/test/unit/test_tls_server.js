/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Need profile dir to store the key / cert
do_get_profile();
// Ensure PSM is initialized
Cc["@mozilla.org/psm;1"].getService(Ci.nsISupports);

const { Services } = Cu.import("resource://gre/modules/Services.jsm", {});
const { NetUtil } = Cu.import("resource://gre/modules/NetUtil.jsm", {});
const { Promise: promise } =
  Cu.import("resource://gre/modules/Promise.jsm", {});
const certService = Cc["@mozilla.org/security/local-cert-service;1"]
                    .getService(Ci.nsILocalCertService);
const certOverrideService = Cc["@mozilla.org/security/certoverride;1"]
                            .getService(Ci.nsICertOverrideService);
const socketTransportService =
  Cc["@mozilla.org/network/socket-transport-service;1"]
  .getService(Ci.nsISocketTransportService);

function run_test() {
  run_next_test();
}

function getCert() {
  let deferred = promise.defer();
  certService.getOrCreateCert("tls-test", {
    handleCert: function(c, rv) {
      if (rv) {
        deferred.reject(rv);
        return;
      }
      deferred.resolve(c);
    }
  });
  return deferred.promise;
}

function startServer(cert, expectingPeerCert, clientCertificateConfig) {
  let tlsServer = Cc["@mozilla.org/network/tls-server-socket;1"]
                  .createInstance(Ci.nsITLSServerSocket);
  tlsServer.init(-1, true, -1);
  tlsServer.serverCert = cert;

  let input, output;

  let listener = {
    onSocketAccepted: function(socket, transport) {
      do_print("Accept TLS client connection");
      let connectionInfo = transport.securityInfo
                           .QueryInterface(Ci.nsITLSServerConnectionInfo);
      connectionInfo.setSecurityObserver(listener);
      input = transport.openInputStream(0, 0, 0);
      output = transport.openOutputStream(0, 0, 0);
    },
    onHandshakeDone: function(socket, status) {
      do_print("TLS handshake done");
      if (expectingPeerCert) {
        ok(!!status.peerCert, "Has peer cert");
        ok(status.peerCert.equals(cert), "Peer cert matches expected cert");
      } else {
        ok(!status.peerCert, "No peer cert (as expected)");
      }

      equal(status.tlsVersionUsed, Ci.nsITLSClientStatus.TLS_VERSION_1_2,
            "Using TLS 1.2");
      let expectedCipher;
      if (expectedVersion >= 772) {
        expectedCipher = "TLS_AES_128_GCM_SHA256";
      } else {
        expectedCipher = "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256";
      }
      equal(status.cipherName, expectedCipher,
            "Using expected cipher");
      equal(status.keyLength, 128, "Using 128-bit key");
      equal(status.macLength, 128, "Using 128-bit MAC");

      input.asyncWait({
        onInputStreamReady: function(input) {
          NetUtil.asyncCopy(input, output);
        }
      }, 0, 0, Services.tm.currentThread);
    },
    onStopListening: function() {}
  };

  tlsServer.setSessionCache(false);
  tlsServer.setSessionTickets(false);
  tlsServer.setRequestClientCertificate(clientCertificateConfig);

  tlsServer.asyncListen(listener);

  return tlsServer.port;
}

function storeCertOverride(port, cert) {
  let overrideBits = Ci.nsICertOverrideService.ERROR_UNTRUSTED |
                     Ci.nsICertOverrideService.ERROR_MISMATCH;
  certOverrideService.rememberValidityOverride("127.0.0.1", port, cert,
                                               overrideBits, true);
}

function startClient(port, cert, expectingBadCertAlert) {
  let SSL_ERROR_BASE = Ci.nsINSSErrorsService.NSS_SSL_ERROR_BASE;
  let SSL_ERROR_BAD_CERT_ALERT = SSL_ERROR_BASE + 17;
  let transport =
    socketTransportService.createTransport(["ssl"], 1, "127.0.0.1", port, null);
  let input;
  let output;

  let inputDeferred = promise.defer();
  let outputDeferred = promise.defer();

  let handler = {

    onTransportStatus: function(transport, status) {
      if (status === Ci.nsISocketTransport.STATUS_CONNECTED_TO) {
        output.asyncWait(handler, 0, 0, Services.tm.currentThread);
      }
    },

    onInputStreamReady: function(input) {
      try {
        let data = NetUtil.readInputStreamToString(input, input.available());
        equal(data, "HELLO", "Echoed data received");
        input.close();
        output.close();
        inputDeferred.resolve();
      } catch (e) {
        let errorCode = -1 * (e.result & 0xFFFF);
        if (expectingBadCertAlert && errorCode == SSL_ERROR_BAD_CERT_ALERT) {
          inputDeferred.resolve();
        } else {
          inputDeferred.reject(e);
        }
      }
    },

    onOutputStreamReady: function(output) {
      try {
        // Set the client certificate as appropriate.
        if (cert) {
          let clientSecInfo = transport.securityInfo;
          let tlsControl = clientSecInfo.QueryInterface(Ci.nsISSLSocketControl);
          tlsControl.clientCert = cert;
        }

        output.write("HELLO", 5);
        do_print("Output to server written");
        outputDeferred.resolve();
        input = transport.openInputStream(0, 0, 0);
        input.asyncWait(handler, 0, 0, Services.tm.currentThread);
      } catch (e) {
        let errorCode = -1 * (e.result & 0xFFFF);
        if (errorCode == SSL_ERROR_BAD_CERT_ALERT) {
          do_print("Server doesn't like client cert");
        }
        outputDeferred.reject(e);
      }
    }

  };

  transport.setEventSink(handler, Services.tm.currentThread);
  output = transport.openOutputStream(0, 0, 0);

  return promise.all([inputDeferred.promise, outputDeferred.promise]);
}

// Replace the UI dialog that prompts the user to pick a client certificate.
do_load_manifest("client_cert_chooser.manifest");

add_task(function*() {
  let cert = yield getCert();
  ok(!!cert, "Got self-signed cert");
  let port = startServer(cert, true, Ci.nsITLSServerSocket.REQUIRE_ALWAYS);
  storeCertOverride(port, cert);
  yield startClient(port, cert, false);
});

add_task(function*() {
  let cert = yield getCert();
  ok(!!cert, "Got self-signed cert");
  let port = startServer(cert, true, Ci.nsITLSServerSocket.REQUIRE_ALWAYS);
  storeCertOverride(port, cert);
  yield startClient(port, null, true);
});

add_task(function*() {
  let cert = yield getCert();
  ok(!!cert, "Got self-signed cert");
  let port = startServer(cert, true, Ci.nsITLSServerSocket.REQUEST_ALWAYS);
  storeCertOverride(port, cert);
  yield startClient(port, cert, false);
});

add_task(function*() {
  let cert = yield getCert();
  ok(!!cert, "Got self-signed cert");
  let port = startServer(cert, false, Ci.nsITLSServerSocket.REQUEST_ALWAYS);
  storeCertOverride(port, cert);
  yield startClient(port, null, false);
});

add_task(function*() {
  let cert = yield getCert();
  ok(!!cert, "Got self-signed cert");
  let port = startServer(cert, false, Ci.nsITLSServerSocket.REQUEST_NEVER);
  storeCertOverride(port, cert);
  yield startClient(port, cert, false);
});

add_task(function*() {
  let cert = yield getCert();
  ok(!!cert, "Got self-signed cert");
  let port = startServer(cert, false, Ci.nsITLSServerSocket.REQUEST_NEVER);
  storeCertOverride(port, cert);
  yield startClient(port, null, false);
});

var net = require('net');
var util = require('util');
var readline = require('readline');

// --------------------------------------
// 	Input Handling for exiting
// --------------------------------------

var rl = readline.createInterface(process.stdin, process.stdout);

// On stdin eof, done (ctrl+D)
rl.on('close', function() {
    server.close();
    process.exit();
});

// On SIGINT (ctrl+C)
process.on('SIGINT', function() {
    server.close();
    process.exit();
});

// --------------------------------------
// 	Set up server to listen for connections
// --------------------------------------

var serverPort = parseInt(process.argv[2]);

var server = net.createServer(function(socket) {
	new RequestHandler(socket);
});

server.on('error', function(err) {
	console.log(err);
});

server.listen(serverPort, function(err) {
	if(err) throw err;
	address = server.address();
	console.log("Proxy listening on " + address.address + ":" + address.port);
});

// --------------------------------------
// 	Handles a single request / session
// --------------------------------------

var RequestHandler = function(socket) {

	var serverSocket;

	// Temporary storage for buffering the data
	var prevData;

	socket.on('data', handleInitialMessage);

	// Handles the initial message
	function handleInitialMessage(data) {

		// if we are in the middle of buffering a header
		if(prevData) {
			// add this data to the end of our header buffer
			data = Buffer.concat([prevData, data], prevData.length + data.length);
		}

		// Gets our header string if we have the entire header buffered, or false if not
		var header = getHeaderString(data);

		// If we have yet to receive the entire header
		if(!header) {
			// Get our buffer ready for the next packet
			prevData = data;
			return;
		}

		// When we have the entire header, no longer call this function when getting new data
		socket.removeListener('data', handleInitialMessage);

		var method = getMethod(header);
		var serverInfo = getHostname(header);
		
		console.log(">>> " + header.split("\r\n")[0]);

		if(method === 'CONNECT') {
			handleConnectTunnel(serverInfo);
		} else {
			handleNormalRequest(serverInfo, data);
		}
	}

	// Handles setting up a tunnel to the given server
	function handleConnectTunnel(serverInfo) {
		serverSocket = net.createConnection(serverInfo, function() {

			socket.on('close', endConnection);
			socket.on('error', endConnection);
			serverSocket.on('close', endConnection);

			// Connect the two sockets
			serverSocket.pipe(socket);
			socket.pipe(serverSocket);

			// Let the browser know the connection is set up
			socket.write("HTTP/1.1 200 OK\r\n\r\n");

		});

		// If we can't make a connection, let the browser know
		serverSocket.on('error', function() {
			socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			endConnection();
		});
	}

	// Handles communicating the given HTTP request to the given server
	// initialData contains the entire request header, and whatever data
	// came in on the same packet as the last of the header data
	function handleNormalRequest(serverInfo, initialData) {
		serverSocket = net.createConnection(serverInfo, function() {

			socket.on('close', endConnection);
			socket.on('error', endConnection);
			serverSocket.on('close', endConnection);

			// buffer for return header
			var prevData;

			// Handles the return header
			var handleReturnHeader = function(data) {
				// if we are in the middle of buffering a header
				if(prevData) {
					// add this data to the end of our header buffer
					data = Buffer.concat([prevData, data], prevData.length + data.length);
				}

				// Gets our header string if we have the entire header buffered, or false if not
				var header = getHeaderString(data);

				// If we have yet to receive the entire header
				if(!header) {
					// Get our buffer ready for the next packet
					prevData = data;
					return;
				}

				// If we have the entire header, no longer call this function on getting data
				serverSocket.removeListener('data', handleReturnHeader);

				// pipe all data from the server to the browser
				serverSocket.pipe(socket);

				// Send the modified header plus whatever data is buffered (if any)
				// to the browser.
				socket.write(constructPacket(data));
			};

			// Set up initial handler for server data
			serverSocket.on('data', handleReturnHeader);

			// pipe all data from the browser to the server
			socket.pipe(serverSocket);

			// Send the modified header plus whatever data is buffered (if any)
			// to the browser.
			serverSocket.write(constructPacket(initialData));
		});

		// If we can't connect to the server, print an error message and close the request.
		serverSocket.on('error', function() {
			console.log("Unable to establish connection to " + serverInfo.host + " on port " + serverInfo.port);
			endConnection();
		});
	}

	function constructPacket(data) {
		var header = getHeaderString(data);
		var newHeader = formatHeader(header);
		// Add \r\n\r\n to denote the end of the header
		var headerBuf = new Buffer(newHeader + "\r\n\r\n");
		// Represents any data that was buffered at the end of the header
		var payload = data.slice(header.length + 4);
		return Buffer.concat([headerBuf, payload]);
	}

	function getHeaderString(data) {
		var splitString = data.toString().split("\r\n\r\n");
		// if we don't have the full header
		if(splitString.length === 1) {
			return false;
		} else {
			return data.toString().split("\r\n\r\n")[0];
		}
	}

	// Get the method being used in the request
	function getMethod(headerString) {
		var splitHeader = headerString.split("\r\n");
		var message = splitHeader[0].split(" ")[0];
		return message;
	}

	// Get the host and port we are connecting to
	function getHostname(headerString) {
		var splitHeader = headerString.split("\r\n");

		var hostLine = '';
		var port = '';

		// Split url by colons
		var urlSplit = splitHeader[0].split(" ")[1].split(":");
		// If we have two or more colons, check if the last token is a port number
		if(urlSplit.length >= 3 && !isNaN(urlSplit[urlSplit.length - 1])) {
			port = urlSplit[2];
		// If not, check if we have an https address
		} else if(urlSplit[0] === "https") {
			port = "443";
		// Default to port 80.
		} else {
			port = "80";
		}
		// For each line in the header
		for(var i = 1; i < splitHeader.length; i++) {
			// If this is the host line
			if(splitHeader[i].slice(0,5) === 'Host:') {
				// split by colon
				var hostLineSplit = splitHeader[i].slice(6).split(":");
				// If our host line has a port at the end
				if(hostLineSplit.length === 2 && !isNaN(hostLineSplit[1])) {
					port = hostLineSplit[1];
				}
				hostLine = hostLineSplit[0];
				break;
			}
		}
		return {host: hostLine, port: parseInt(port)};
	}

	function formatHeader(headerString) {
		// split header by line
		var splitHeader = headerString.split("\r\n");

		// Should match any string formatted as "HTTP/#.#"
		var anyHTTP = new RegExp('HTTP/.\..');
		// Replace with HTTP/1.0
		splitHeader[0] = splitHeader[0].replace(anyHTTP, 'HTTP/1.0');

		// For each line in the header
		for(var i = 1; i < splitHeader.length; i++) {
			if(splitHeader[i] === "Connection: keep-alive") {
				splitHeader[i] = "Connection: close";
			}
			if(splitHeader[i] === "Proxy-Connection: keep-alive") {
				splitHeader[i] = "Proxy-Connection: close";
			}
		}
		return splitHeader.join("\r\n");
	}

	// Unpipe our connections if they are piped, and end both.
	function endConnection() {
		socket.unpipe();
		serverSocket.unpipe();
		socket.end();
		serverSocket.end();
	}

};
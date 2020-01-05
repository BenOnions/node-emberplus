const EventEmitter = require('events').EventEmitter;
const util = require('util');
const S101Server = require('./client.js').S101Server;
const ember = require('./EmberLib');

function TreeServer(host, port, tree) {
    TreeServer.super_.call(this);
    var self = this;
    self._debug = false;

    self.callback = undefined;
    self.timeoutValue = 2000;
    self.server = new S101Server(host, port);
    self.tree = tree;
    self.clients = new Set();
    self.subscribers = {};

    self.server.on('listening', () => {
        if (self._debug) { console.log("listening"); }
        self.emit('listening');
        if (self.callback !== undefined) {
            self.callback();
            self.callback = undefined;
        }
    });

    self.server.on('connection', (client) => {
        if (self._debug) { console.log("ember new connection from", client.remoteAddress()); }
        self.clients.add(client);
        client.on("emberTree", (root) => {
            if (self._debug) { console.log("ember new request from", client.remoteAddress(), root); }
            // Queue the action to make sure responses are sent in order.
            client.addRequest(() => {
                try {
                    let path = self.handleRoot(client, root);
                    self.emit("request", {client: client.remoteAddress(), root: root, path: path});
                }
                catch(e) {
                    if (self._debug) { console.log(e.stack); }
                    self.emit("error", e);
                }
            });
        });
        client.on("disconnected", () => {
            self.clients.delete(client);
            self.emit('disconnect', client.remoteAddress());
        });
        client.on("error", error => {
            self.emit('clientError', { remoteAddress: client.remoteAddress(), error });
        });
        self.emit('connection', client.remoteAddress());
    });

    self.server.on('disconnected', () => {
        self.emit('disconnected', client.remoteAddress());
    });

    self.server.on("error", (e) => {
        self.emit("error", e);
        if (self.callback !== undefined) {
            self.callback(e);
        }
    });

}

util.inherits(TreeServer, EventEmitter);


TreeServer.prototype.listen = function() {
    return new Promise((resolve, reject) => {
        this.callback = (e) => {
            if (e == null) {
                return resolve();
            }
            return reject(e);
        };
        this.server.listen();
    });
};

TreeServer.prototype.close = function () {
    return new Promise((resolve, reject) => {
        this.callback = (e) => {
            if (e == null) {
                return resolve();
            }
            return reject(e);
        };
        this.server.server.close();
    });
};

TreeServer.prototype.handleRoot = function(client, root) {
    if ((root == null) || (root.elements == null) || (root.elements.size < 1)) {
        // ignore empty requests.
        return;
    }

    const node = root.getChildren()[0];
    client.request = node;

    if (node.path !== undefined) {
        return this.handleQualifiedNode(client, node);
    }
    else if (node.isCommand()) {
        // Command on root element
        this.handleCommand(client, this.tree, node);
        return "root";
    }
    else {
        return this.handleNode(client, node);
    }
}

TreeServer.prototype.handleError = function(client, node) {
    if (client !== undefined) {
        const res = node == null ? this.tree.getMinimal() : node;
        client.sendBERNode(res);
    }
}


TreeServer.prototype.handleQualifiedNode = function(client, node) {
    const path = node.path;
    // Find this element in our tree
    const element = this.tree.getElementByPath(path);

    if (element == null) {
        this.emit("error", new Error(`unknown element at path ${path}`));
        return this.handleError(client);
    }
    
    if (node.hasChildren()) {
        for(child of node.children) {
            if (child.isCommand()) {
                this.handleCommand(client, element, child);
            }
            break;
        }
    }
    else {
        if (node.isMatrix()) {
            this.handleQualifiedMatrix(client, element, node);
        }
        else if (node.isParameter()) {
            this.handleQualifiedParameter(client, element, node);
        }        
    }
    return path;
}


TreeServer.prototype.handleNode = function(client, node) {
    // traverse the tree
    let element = node;
    let path = [];
    while(element !== undefined) {
        if (element.number == null) {
            this.emit("error", "invalid request");
            return;
        }
        if (element.isCommand()) {
            break;
        }
        path.push(element.number);

        let children = element.getChildren();
        if ((! children) || (children.length === 0)) {
            break;
        }
        element = element.children[0];
    }
    let cmd = element;

    if (cmd == null) {
        this.emit("error", "invalid request");
        return this.handleError(client);
    }

    element = this.tree.getElementByPath(path.join("."));

    if (element == null) {
        this.emit("error", new Error(`unknown element at path ${path}`));
        return this.handleError(client);
    }

    if (cmd.isCommand()) {
        this.handleCommand(client, element, cmd);
    }
    else if ((cmd.isCommand()) && (cmd.connections !== undefined)) {
        this.handleMatrixConnections(client, element, cmd.connections);
    }
    else if ((cmd.isParameter()) &&
        (cmd.contents !== undefined) && (cmd.contents.value !== undefined)) {
        if (this._debug) { console.log(`setValue for element at path ${path} with value ${cmd.contents.value}`); }
        this.setValue(element, cmd.contents.value, client);
        let res = this.getResponse(element);
        client.sendBERNode(res)
        this.updateSubscribers(element.getPath(), res, client);
    }
    else {
        this.emit("error", new Error("invalid request format"));
        if (this._debug) { console.log("invalid request format"); }
        return this.handleError(client, element.getTreeBranch());
    }
    return path;
}

TreeServer.prototype.handleQualifiedMatrix = function(client, element, matrix)
{
    this.handleMatrixConnections(client, element, matrix.connections);
}

TreeServer.prototype.handleQualifiedParameter = function(client, element, parameter)
{
    if (parameter.contents.value !== undefined) {
        this.setValue(element, parameter.contents.value, client);
        let res = this.getQualifiedResponse(element);
        client.sendBERNode(res)
        this.updateSubscribers(element.getPath(), res, client);
    }
}


TreeServer.prototype.handleMatrixConnections = function(client, matrix, connections, response = true) {
    var res,conResult;
    var root; // ember message root
    if (this._debug) {
        console.log("Handling Matrix Connection");
    }
    if (client != null && client.request.isQualified()) {
        root = new ember.Root();
        res = new ember.QualifiedMatrix(matrix.getPath());
        //root.elements = [res]; // do not use addchild or the element will get removed from the tree.
        root.addElement(res);
    }
    else {
        res = new ember.MatrixNode(matrix.number);
        root = matrix._parent.getTreeBranch(res);
    }    
    res.connections = {};
    for(let id in connections) {        
        if (!connections.hasOwnProperty(id)) {
            continue;
        }
        let connection = connections[id];
        conResult = new ember.MatrixConnection(connection.target);
        let emitType;
        res.connections[connection.target] = conResult;
        
        if (matrix.connections[connection.target].isLocked()) {
            conResult.disposition = ember.MatrixDisposition.locked;
        }
        else if (matrix.contents.type !== ember.MatrixType.nToN && 
            connection.operation !== ember.MatrixOperation.disconnect &&
            connection.sources != null && connection.sources.length === 1) {
            if (matrix.contents.type === ember.MatrixType.oneToOne) {
                // if the source is being used already, disconnect it.
                const targets = matrix.getSourceConnections(connection.sources[0]);
                if (targets.length === 1 && targets[0] !== connection.target) {
                    const disconnect = new ember.MatrixConnection(targets[0]);
                    disconnect.setSources([]);
                    disconnect.disposition = ember.MatrixDisposition.modified;
                    res.connections[targets[0]] = disconnect;
                    matrix.setSources(targets[0], []);
                    if (response) {
                        this.emit("matrix-disconnect", {
                            target: targets[0],
                            sources: connection.sources,
                            client: client == null ? null : client.remoteAddress()
                        });
                    }
                }
            }
            // if the target is connected already, disconnect it
            if (matrix.connections[connection.target].sources != null && 
                matrix.connections[connection.target].sources.length === 1) {
                if (matrix.contents.type === ember.MatrixType.oneToN) {
                    const disconnectSource = this.getDisconnectSource(matrix, connection.target);
                    if (matrix.connections[connection.target].sources[0] == connection.sources[0]) {
                        if (disconnectSource != null && disconnectSource != -1 &&
                            disconnectSource != connection.sources[0]) {
                            connection.sources = [disconnectSource];
                        }
                        else {
                            // do nothing
                            connection.operarion = ember.MatrixOperation.tally;
                        }
                    }
                }
                if (matrix.connections[connection.target].sources[0] !== connection.sources[0]) {
                    const source = matrix.connections[connection.target].sources[0];
                    matrix.setSources(connection.target, []);
                    if (response) {
                        this.emit("matrix-disconnect", {
                            target: connection.target,
                            sources: [source],
                            client: client == null ? null : client.remoteAddress()
                        });
                    }
                }
                else if (matrix.contents.type === ember.MatrixType.oneToOne) {
                    // let's change the request into a disconnect
                    connection.operation = ember.MatrixOperation.disconnect;
                }
            }
        }
        
        if (connection.operation !== ember.MatrixOperation.disconnect &&
            connection.sources != null && connection.sources.length > 0 &&
            matrix.canConnect(connection.target,connection.sources,connection.operation)) {
            // Apply changes
            if ((connection.operation == null) ||
                (connection.operation.value == ember.MatrixOperation.absolute)) {
                matrix.setSources(connection.target, connection.sources);
                emitType = "matrix-change";
            }
            else if (connection.operation == ember.MatrixOperation.connect) {
                matrix.connectSources(connection.target, connection.sources);
                emitType = "matrix-connect";
            }
            conResult.disposition = ember.MatrixDisposition.modified;
        }
        else if (connection.operation !== ember.MatrixOperation.disconnect &&
            connection.sources != null && connection.sources.length === 0 &&
            matrix.connections[connection.target].sources != null && 
            matrix.connections[connection.target].sources.length > 0) {
            // let's disconnect
            if (response) {
                this.emit("matrix-disconnect", {
                    target: connection.target,
                    sources: matrix.connections[connection.target].sources,
                    client: client == null ? null : client.remoteAddress()
                });
            }
            matrix.setSources(connection.target, []);
            conResult.disposition = ember.MatrixDisposition.modified;
        }
        else if (connection.operation === ember.MatrixOperation.disconnect &&
            matrix.connections[connection.target].sources != null &&
            matrix.connections[connection.target].sources.length > 0) { 
            // Disconnect            
            if (matrix.contents.type === ember.MatrixType.oneToN) {
                const disconnectSource = this.getDisconnectSource(matrix, connection.target);
                if (matrix.connections[connection.target].sources[0] == connection.sources[0]) {
                    if (disconnectSource != null && disconnectSource != -1 &&
                        disconnectSource != connection.sources[0]) {
                        if (response) {
                            this.emit("matrix-disconnect", {
                                target: connection.target,
                                sources: matrix.connections[connection.target].sources,
                                client: client == null ? null : client.remoteAddress()
                            });
                        }
                        matrix.setSources(connection.target, [disconnectSource]);
                        connection.operarion = ember.MatrixOperation.modified;
                    }
                    else {
                        // do nothing
                        connection.operarion = ember.MatrixOperation.tally;
                    }
                }
            }
            else {
                matrix.disconnectSources(connection.target, connection.sources);
                conResult.disposition = ember.MatrixDisposition.modified;
                emitType = "matrix-disconnect";
            }
        }
        else if (conResult.disposition !== ember.MatrixDisposition.locked){
            if (this._debug) {
                console.log(`Invalid Matrix operation ${connection.operarion} on target ${connection.target} with sources ${JSON.stringify(connection.sources)}`);
            }
            conResult.disposition = ember.MatrixDisposition.tally;
        }

        // Send response or update subscribers.
        conResult.sources = matrix.connections[connection.target].sources;
        if (response) {            
            // We got a request so emit something.
            this.emit(emitType, {
                target: connection.target,
                sources: connection.sources,
                client: client == null ? null : client.remoteAddress()
            });
        }       
    }
    if (client != null) {
        client.sendBERNode(root);
    }

    if (conResult != null && conResult.disposition !== ember.MatrixDisposition.tally) {
        if (this._debug) { 
            console.log("Updating subscribers for matrix change");
        }
        this.updateSubscribers(matrix.getPath(), root, client);
    }
}

const validateMatrixOperation = function(matrix, target, sources) {
    if (matrix == null) {
        throw new Error(`matrix not found with path ${path}`);
    }
    if (matrix.contents == null) {
        throw new Error(`invalid matrix at ${path} : no contents`);
    }
    if (matrix.contents.targetCount == null) {
        throw new Error(`invalid matrix at ${path} : no targetCount`);
    }
    if ((target < 0) || (target >= matrix.contents.targetCount)) {
        throw new Error(`target id ${target} out of range 0 - ${matrix.contents.targetCount}`);
    }
    if (sources.length == null) {
        throw new Error("invalid sources format");
    }
}

const doMatrixOperation = function(server, path, target, sources, operation) {
    let matrix = server.tree.getElementByPath(path);

    validateMatrixOperation(matrix, target, sources);

    let connection = new ember.MatrixConnection(target);
    connection.sources = sources;
    connection.operation = operation;
    server.handleMatrixConnections(undefined, matrix, [connection], false);
}

TreeServer.prototype.matrixConnect = function(path, target, sources) {
    doMatrixOperation(this, path, target, sources, ember.MatrixOperation.connect);
}

TreeServer.prototype.matrixDisconnect = function(path, target, sources) {
    doMatrixOperation(this, path, target, sources, ember.MatrixOperation.disconnect);
}

TreeServer.prototype.matrixSet = function(path, target, sources) {
    doMatrixOperation(this, path, target, sources, ember.MatrixOperation.absolute);
}

TreeServer.prototype.handleQualifiedFunction = function(client, element, node) {

}


TreeServer.prototype.handleCommand = function(client, element, cmd) {
    switch(cmd.number) {
        case ember.COMMAND_GETDIRECTORY:
            this.handleGetDirectory(client, element);
            break;
        case ember.COMMAND_SUBSCRIBE:
            this.handleSubscribe(client, element);
            break;
        case ember.COMMAND_UNSUBSCRIBE:
            this.handleUnSubscribe(client, element);
            break;
        case ember.COMMAND_INVOKE:
            this.handleInvoke(client, cmd.invocation, element);
            break;
        default:
            this.emit("error", new Error(`invalid command ${cmd.number}`));
            break;
    }
}

TreeServer.prototype.getResponse = function(element) {
    return element.getTreeBranch(undefined, function(node) {
        node.update(element);
        let children = element.getChildren();
        if (children != null) {
            for (let i = 0; i < children.length; i++) {
                node.addChild(children[i].getDuplicate());
            }
        }
        else if (this._debug) {
            console.log("getResponse","no children");
        }
    });
}

TreeServer.prototype.getQualifiedResponse = function(element) {
    const res = new ember.Root();
    let dup;
    if (element.isRoot() === false) {
        dup = element.toQualified();
    }
    let children = element.getChildren();
    if (children != null) {
        for (let i = 0; i < children.length; i++) {
            res.addChild(children[i].toQualified().getMinimalContent());
        }
    }
    else {
       res.addChild(dup);
    }
    return res;
}

TreeServer.prototype.handleInvoke = function(client, invocation, element) {
    const result = new ember.InvocationResult();
    result.invocationId = invocation.id;
    if (element == null || !element.isFunction()) {
        result.setFailure();        
    }
    else {
        try {        
            result.setResult(element.func(invocation.arguments));
        }
        catch(e){
            this.emit("error", e);
            result.setFailure();
        }
    }
    const res = new ember.Root();
    res.addResult(result);
    client.sendBERNode(res);
}

TreeServer.prototype.handleGetDirectory = function(client, element) {
    if (client !== undefined) {
        if ((element.isMatrix() || element.isParameter()) &&
            (!element.isStream())) {
            // ember spec: parameter without streamIdentifier should
            // report their value changes automatically.
            this.subscribe(client, element);
        }
        else if (element.isNode()) {
            const children = element.getChildren();
            if (children != null) {
                for (let i = 0; i < children.length; i++) {
                    const child = children[i];
                    if ((child.isMatrix() || child.isParameter()) &&
                        (!child.isStream())) {
                        this.subscribe(client, child);
                    }
                }
            }
        }

        const res = this.getQualifiedResponse(element);
        if (this._debug) {
            console.log("getDirectory response", res);
        }
        client.sendBERNode(res);
    }
}

TreeServer.prototype.handleSubscribe = function(client, element) {
    if (this._debug) {
        console.log("subscribe");
    }
    this.subscribe(client, element);
}

TreeServer.prototype.handleUnSubscribe = function(client, element) {
    if (this._debug) {
        console.log("unsubscribe");
    }
    this.unsubscribe(client, element);
}


TreeServer.prototype.subscribe = function(client, element) {
    const path = element.getPath();
    if (this.subscribers[path] == null) {
        this.subscribers[path] = new Set();
    }
    this.subscribers[path].add(client);
}

TreeServer.prototype.unsubscribe = function(client, element) {
    const path = element.getPath();
    if (this.subscribers[path] == null) {
        return;
    }
    this.subscribers[path].delete(client);
}

TreeServer.prototype.setValue = function(element, value, origin, key) {
    return new Promise((resolve, reject) => {
        // Change the element value if write access permitted.
        if (element.contents == null) {
            return resolve();
        }
        if (element.isParameter()) {
            if ((element.contents.access !== undefined) &&
                (element.contents.access.value > 1)) {
                element.contents.value = value;
                const res = this.getResponse(element);
                this.updateSubscribers(element.getPath(),res, origin);
                this.emit("value-change", element);
            }
        }
        else if (element.isMatrix()) {
            if ((key !== undefined) && (element.contents.hasOwnProperty(key))) {
                element.contents[key] = value;
                const res = this.getResponse(element);
                this.updateSubscribers(element.getPath(),res, origin);
                this.emit("value-change", element);
            }
        }
        return resolve();
    });
}

TreeServer.prototype.replaceElement = function(element) {
    let path = element.getPath();
    let parent = this.tree.getElementByPath(path);
    if ((parent == null)||(parent._parent == null)) {
        throw new Error(`Could not find element at path ${path}`);
    }
    parent = parent._parent;
    let children = parent.getChildren();
    let newList = [];
    for(let i = 0; i <= children.length; i++) {
        if (children[i] && children[i].getPath() == path) {
            element._parent = parent; // move it to new tree.
            children[i] = element;
            let res = this.getResponse(element);
            this.updateSubscribers(path,res);
            return;
        }
    }
}

TreeServer.prototype.getDisconnectSource = function(matrix, targetID) {
    if (matrix.defaultSources) {
        return matrix.defaultSources[targetID].contents.value;
    }
    if (matrix.contents.labels == null || matrix.contents.labels.length == 0) {
        return null;
    }
    const basePath = matrix.contents.labels[0].basePath;
    const labels = this.tree.getElementByPath(basePath);
    const number = labels.getNumber() + 1;
    const parent = labels.getParent();
    const children = parent.getChildren();
    for(let child of children) {
        if (child.getNumber() === number) {
            matrix.defaultSources = child.getChildren();
            return matrix.defaultSources[targetID].contents.value;
        }
    }
    return null;
}

TreeServer.prototype.updateSubscribers = function(path, response, origin) {
    if (this.subscribers[path] == null) {
        return;
    }

    for (let client of this.subscribers[path]) {
        if (client === origin) {
            continue; // already sent the response to origin
        }
        if (this.clients.has(client)) {
            client.queueMessage(response);
        }
        else {
            // clean up subscribers - client is gone
            this.subscribers[path].delete(client);
        }
    }
}

const parseMatrixContent = function(matrixContent, content) {
    if (content.labels) {
        matrixContent.labels = [];
        for(let l = 0; l < content.labels.length; l++) {
            if (typeof (content.labels[l]) === "object") {
                matrixContent.labels.push(
                    new ember.Label(
                        content.labels[l].basePath,
                        content.labels[l].description
                    )
                );
            }
            else {
                // for backward compatibility... Remove in the future
                matrixContent.labels.push(
                    new ember.Label(content.labels[l])
                );
            }
        }
        delete content.labels;
    }
    if (content.type != null) {
        if (content.type == "oneToN") {
            matrixContent.type = ember.MatrixType.oneToN;
        }
        else if (content.type == "oneToOne") {
            matrixContent.type = ember.MatrixType.oneToOne;
        }
        else if (content.type == "nToN") {
            matrixContent.type = ember.MatrixType.nToN;  
            matrixContent.maximumTotalConnects = content.maximumTotalConnects == null ? 
                Number(content.targetCount) * Number(content.sourceCount) : Number(content.maximumTotalConnects);                
            matrixContent.maximumConnectsPerTarget = content.maximumConnectsPerTarget == null ?
                Number(content.sourceCount) : Number(content.maximumConnectsPerTarget);
        }
        else {
            throw new Error(`Invalid matrix type ${content.type}`);
        }
        delete content.type;
    }
    if (content.mode != null) {
        if (content.mode == "linear") {
            matrixContent.mode = ember.MatrixMode.linear;
        }
        else if (content.mode == "nonLinear") {
            matrixContent.mode = ember.MatrixMode.nonLinear;
        }
        else {
            throw new Error(`Invalid matrix mode ${content.mode}`);
        }
        delete content.mode;
    }
}

const parseObj = function(parent, obj) {
    for(let i = 0; i < obj.length; i++) {
        let emberElement;
        let content = obj[i];
        let number = content.number !== undefined ? content.number : i;
        delete content.number;
        if (content.value != null) {            
            emberElement = new ember.Parameter(number);
            emberElement.contents = new ember.ParameterContents(content.value);
            if (content.type) {
                emberElement.contents.type = ember.ParameterType.get(content.type);
                delete content.type;
            }
            else {
                emberElement.contents.type = ember.ParameterType.string;
            }
            if (content.access) {
                emberElement.contents.access = ember.ParameterAccess.get(content.access);
                delete content.access;
            }
            else {
                emberElement.contents.access = ember.ParameterAccess.read;
            }
        }
        else if (content.func != null) {
            emberElement = new ember.Function(number, content.func);
            emberElement.contents = new ember.FunctionContent();
            if (content.arguments != null) {
                for(let argument of content.arguments) {
                    emberElement.contents.arguments.push(new ember.FunctionArgument(
                        argument.type,
                        argument.value,
                        argument.name
                    ));
                }
            }
            if (content.result != null) {
                for(let argument of content.result) {
                    emberElement.contents.result.push(new ember.FunctionArgument(
                        argument.type,
                        argument.value,
                        argument.name
                    ));
                }
            }
            delete content.result;
        }
        else if (content.targetCount != null) {
            emberElement = new ember.MatrixNode(number);
            emberElement.contents = new ember.MatrixContents();            
            parseMatrixContent(emberElement.contents, content);            
            if (content.connections) {
                emberElement.connections = {};
                for (let c in content.connections) {
                    if (! content.connections.hasOwnProperty(c)) {
                        continue;
                    }
                    const t = content.connections[c].target != null ? content.connections[c].target : 0;                    
                    emberElement.setSources(t, content.connections[c].sources);
                }
                delete content.connections;
            }
            else {
                emberElement.connections = {};
                for (let t = 0; t < content.targetCount; t++) {
                    let connection = new ember.MatrixConnection(t);
                    emberElement.connections[t] = connection;
                }
            }
        }
        else {
            emberElement = new ember.Node(number);
            emberElement.contents = new ember.NodeContents();
        }
        for(let id in content) {
            if (emberElement.isFunction() && id === "arguments") {
                // we did it already.
                continue;
            }
            if ((id !== "children") &&  (content.hasOwnProperty(id))) {
                emberElement.contents[id] = content[id];
            }
            else {
                parseObj(emberElement, content.children);
            }
        }
        parent.addChild(emberElement);
    }
}

TreeServer.JSONtoTree = function(obj) {
    const tree = new ember.Root();
    parseObj(tree, obj);
    return tree;
}


TreeServer.prototype.toJSON = function() {
    if (this.tree == null) {
        return [];
    }
    const elements = this.tree.getChildren();

    return elements.map(element => element.toJSON());
};

module.exports = TreeServer;
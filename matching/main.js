'use strict';

var client = require('./my_connection.js'),
    fs = require('fs'),
    lzma = require('lzma-native'),
    es = require('event-stream'),
    async = require("async");

// for making console output less boring
const green = '\x1b[32m';
const red = '\x1b[31m';
const orange = '\x1b[33m';
const white = '\x1b[37m';
const blue = `\x1b[34m`;
const score = '\x1b[7m';
const bright = "\x1b[1m";
const reset = '\x1b[0m';

const analyserPath = "resources/analyzer.json";
const mappingPath = "resources/crossref_mapping.json";

function processAction(options) {
    if (options.action === "health") {
        client.cluster.health({}, function (err, resp, status) {
            console.log("ES Health --", resp);
        });
    } else if ((options.action === "index") && (options.force)) {
        // remove previous index
        console.log("force index");

        async.waterfall([
            function indexExists(callback) {
                console.log("indexExists");
                client.indices.exists({
                    index: options.indexName
                }, function (err, resp, status) {
                    if (err) {
                        console.log('indexExists error: ' + err.message);
                        return callback(err);
                    }
                    console.log("indexExists: ", resp);
                    return callback(null, resp);
                });
            },
            function deleteIndex(existence, callback) {
                console.log("deleteIndex: " + existence);
                if (existence) {
                    client.indices.delete({
                        index: options.indexName
                    }, function (err, resp, status) {
                        if (err) {
                            console.error('deleteIndex error: ' + err.message);
                            return callback(err);
                        } else {
                            console.log('Index crossref have been deleted', resp);
                            return callback(null, false);
                        }
                    });
                } else {
                    return callback(null, false);
                }
            },
            function createIndex(existence, callback) {
                console.log("createIndex");
                var analyzers;
                try {
                    analyzers = fs.readFileSync(analyserPath, 'utf8');
                } catch (e) {
                    console.log('error reading analyzer file ' + e);
                }

                if (!existence) {
                    client.indices.create({
                        index: options.indexName,
                        body: analyzers
                    }, function (err, resp, status) {
                        if (err) {
                            console.log('createIndex error: ' + err.message);
                            return callback(err)
                        }
                        console.log('createIndex: ', resp);
                        return callback(null, true);
                    });
                }

            },
            function addMappings(existence, callback) {
                var mapping;
                try {
                    mapping = fs.readFileSync(mappingPath, 'utf8');
                } catch (e) {
                    console.log('error reading mapping file ' + e);
                }

                // put the mapping now
                client.indices.putMapping({
                    index: options.indexName,
                    type: options.docType,
                    body: mapping
                }, function (err, resp, status) {
                    if (err) {
                        console.log('mapping error: ' + err.message);
                    } else
                        console.log("mapping loaded");
                    return callback(null, true);
                });
            }
        ], (err, results) => {
            if (err) {
                console.log('setting error: ' + err);
            }

            if (options.action === "index") {
                // launch the heavy indexing stuff...
                index(options);
            }
        })
    }

}

/**
 * This function removes some non-used stuff from a crossref work entry,
 * in particular the citation information, which represent a considerable
 * amount of data.
 */
function massage(data) {
    var jsonObj = JSON.parse(data);
    delete jsonObj.reference;
    delete jsonObj.abstract;
    delete jsonObj.indexed;

    return jsonObj;
}

function index(options) {
    var readStream = fs.createReadStream(options.dump)
        .pipe(lzma.createDecompressor())
        .pipe(es.split())
        .pipe(es.map(function (data, cb) {
            // prepare/massage the data
            console.log(data);
            data = massage(data);
            var obj = new Object();

            // - migrate id from '_id' to 'id'
            obj._id = data._id.$oid;
            delete data._id;

            // Just keep the fields we want to index

            // - Main fields (in the mapping)
            obj.title = data.title;
            obj.DOI = data.DOI;

            if (data.author) {
                obj.author = "";
                for (var aut in data.author) {
                    if (data.author[aut].sequence === "first")
                        obj.first_author = data.author[aut].family
                    obj.author += data.author[aut].family + " ";
                }
                obj.author = obj.author.trim();
            }

            //TODO: check
            // obj.first_page = data.first_page;

            obj.journal = data['container-title'];
            obj.abbreviated_journal = data['short-container-title'];

            obj.volume = data.volume;
            obj.issue = data.issue;
            obj.year = data.year;

            // - Additional fields (not in the mapping)
            /*obj.publisher = data.publisher;
            obj.ISSN = data.ISSN;
            obj.prefix = data.prefix;
            obj.language = data.language;
            obj.alternative_id = data['alternative-id'];
            obj.URL = data.URL;*/

            // store the whole json doc in a field, to avoid further parsing it during indexing
            obj.jsondoc = JSON.stringify(data);

            cb(null, obj)
        }))
        .on('error',
            function (error) {
                console.log("Error occurred: " + error);
            }
        )
        .on('finish',
            function () {
                console.log("Finished. ")
            }
        );

    async.series(
        [
            function (next) {
                var i = 0;
                var batch = [];
                var previous_end = start;

                readStream.on("data", function (doc) {
                    // console.log('indexing %s', doc.id);
                    var localId = doc._id;
                    delete doc._id;
                    batch.push({
                        index: {
                            "_index": 'crossref',
                            "_type": 'work',
                            "_id": localId
                        }
                    });

                    batch.push(doc);
                    i++;
                    if (i % options.batchSize === 0) {
                        let end = new Date();
                        let total_time = (end - start) / 1000;
                        let intermediate_time = (end - previous_end) / 1000;
                        console.log('Loaded %s records in %d s (%d record/s)', i, total_time, options.batchSize / intermediate_time);
                        client.bulk(
                            {
                                refresh: "wait_for", //we do refresh only at the end
                                body: batch
                            },
                            function (err, resp) {
                                if (err) {
                                    throw err;
                                } else if (resp.errors) {
                                    throw resp;
                                }
                            }
                        );
                        batch = [];
                        previous_end = end;
                    }
                });

                // When the stream ends write the remaining records
                readStream.on("end", function () {
                    if (batch.length > 0) {
                        console.log('Loaded %s records', batch.length);
                        client().bulk({
                            refresh: "true", // we wait for this last batch before refreshing
                            body: batch
                        }, function (err, resp) {
                            if (err) {
                                console.log(err, 'Failed to build index');
                                throw err;
                            } else if (resp.errors) {
                                console.log(resp.errors, 'Failed to build index');
                                throw resp;
                            } else {
                                console.log('Completed crossref indexing.');
                                next();
                            }
                        });
                    } else {
                        next();
                    }

                    batch = [];
                });
            }
        ],
        function (err, results) {
            if (err)
                console.log(err);
            else
                console.log(results);
        }
    );
}

/**
 * Init the main object with paths passed with the command line
 */
function init() {
    var options = new Object();

    // first get the config
    const config = require('./config.json');
    options.indexName = config.indexName;
    options.docType = config.docType;
    options.batchSize = config.batchSize;

    options.action = "health";
    options.concurrency = 100; // number of concurrent call, default is 10
    options.force = false; // delete existing index and full re-indexing if true
    var attribute; // name of the passed parameter

    for (var i = 2, len = process.argv.length; i < len; i++) {
        if (process.argv[i] === "-force") {
            options.force = true;
        } else if (process.argv[i - 1] === "-dump") {
            options.dump = process.argv[i];
        } else if (!process.argv[i].startsWith("-")) {
            options.action = process.argv[i];
        }
    }

    console.log("action: ", red, options.action + "\n", reset);

    // check the dump path, if any
    if (options.dump) {
        fs.lstat(options.dump, (err, stats) => {
            if (err)
                console.log(err);
            if (stats.isDirectory())
                console.log("CrossRef dump path must be a file, not a directory");
            if (!stats.isFile())
                console.log("CrossRef dump path must be a valid file");
        });
    }

    return options;
}

function end() {
    var this_is_the_end = new Date() - start;
    console.info('Execution time: %dms', this_is_the_end)
}

var start;

function main() {
    var options = init();
    start = new Date();
    processAction(options);
}

main();
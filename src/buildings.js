var bearing = require('@turf/bearing').default;
var destination = require('@turf/destination').default;
var along = require('@turf/along').default;
var lineIntersect = require('@turf/line-intersect').default;
var intersect = require('@turf/intersect').default;
var Agentmap = require('./agentmap').Agentmap;

/* Here we define buildingify and all other functions and definitions it relies on. */

/**
 * @typedef {object} Feature
 * @property {string} type - Should be Feature.
 * @property {object} properties - Non-geometric properties describing the map feature.
 * @property {object} geometry - Specification of the feature's geometry.
 * @property {string} geometry.type - The feature's GeoJSON geometry type
 * @property {Array} geometry.coordinates - The coordinates specifying the feature's geometry.
 * @see {@link http://geojson.org/}
 */

/**
 * Generate and setup the desired map features (e.g. streets, houses).
 *
 * @param {Array.<Array.<number>>} bounding_box - The map's top-left and bottom-right coordinates.
 * @param {object} OSM_data - A GeoJSON Feature Collection object containing the OSM features inside the bounding box.
 * @param {string} OSM_data_URL - URL from which to download equivalent OSM_data.
 */
function buildingify(bounding_box, OSM_data, OSM_data_URL) {
	//if (!GeoJSON_data && GeoJSON_data_URL) {}
	
	let street_features = getStreetFeatures(OSM_data);
	
	let street_options = {
		style: {
			"color": "yellow",
			"weight": 4,
			"opacity": .5
		},
	};

	let street_feature_collection = {
		type: "FeatureCollection",
		features: street_features
	};
	
	this.streets = L.geoJSON(
		street_feature_collection,
		street_options
	).addTo(this.map);

	this.streets.eachLayer(function(street) {
		let street_id = street._leaflet_id;
		street.intersections = typeof(street.intersections) === "undefined" ? {} : street.intersections;

		this.streets.eachLayer(function(other_street) {
			let other_street_id = other_street._leaflet_id;
			if (typeof(street.intersections[other_street_id]) === "undefined" && street_id !== other_street_id) {
				let street_coords = street.getLatLngs().map(pointToCoordinateArray),
				other_street_coords = other_street.getLatLngs().map(pointToCoordinateArray),
				intersection_with_indices = getIntersection(street_coords, other_street_coords, [street_id, other_street_id]).map(
					intersection_with_index => [reversedCoordinates(intersection_with_index[0]), 
					intersection_with_index[1]]);		
				intersection = intersection_with_indices.map(int_w_index => int_w_index[0]);
				if (intersection.length > 0) {
					street.intersections[other_street_id] = intersection_with_indices,
					other_street.intersections = typeof(other_street.intersections) === "undefined" ? {} : other_street.intersections,
					other_street.intersections[street_id] = intersection_with_indices;
				}
			}
		}, this);
	}, this);

	//Bind getUnitFeatures to this so it can access the agentmap via this keyword.
	let unit_features = getUnitFeatures.bind(this)(OSM_data, bounding_box);

	let unit_options = {
		style: {
			"color": "green",
			"weight": 1,
			"opacity": .87
		},
	};

	let unit_feature_collection = { 
		type: "FeatureCollection", 
		features: unit_features
	};
	
	this.units = L.geoJSON(
		unit_feature_collection,
		unit_options
	).addTo(this.map);

	this.units.eachLayer(function(unit) {
		unit.street_id = unit.feature.properties.street_id,
		unit.street_anchors = unit.feature.properties.street_anchors,
		unit.neighbors = unit.feature.properties.neighbors.map(function(neighbor) {
			if (neighbor !== null) {
				let neighbor_id;
				this.units.eachLayer(function(neighbor_layer) {
					if (neighbor_layer.feature.properties.id === neighbor.properties.id) {
						neighbor_id = this.units.getLayerId(neighbor_layer);
					}
				}, this);

				return neighbor_id;
			}
			else {
				return null;
			}
		}, this);
	}, this);
}

/**
 * Get all appropriate units within the desired bounding box.
 *
 * @param {Object} OSM_data - A GeoJSON Feature Collection object containing the OSM features inside the bounding box.
 * @returns {Array<Feature>} -  array of features representing real estate units.
 */
function getUnitFeatures(OSM_data, bounding_box) {
	let proposed_unit_features = [];
	
	this.streets.eachLayer(function(layer) {
		let street_feature = layer.feature,
		street_id = layer._leaflet_id,
		proposed_anchors = getUnitAnchors(street_feature, bounding_box),
		new_proposed_unit_features = generateUnitFeatures(proposed_anchors, proposed_unit_features, street_id);
		proposed_unit_features.push(...new_proposed_unit_features);
	});

	unit_features = unitsOutOfStreets(proposed_unit_features, this.streets);

	return unit_features;
}

/**
 * Get all streets from the GeoJSON data.
 *
 * @param {Object} OSM_data - A GeoJSON Feature Collection object containing the OSM streets inside the bounding box.
 * @returns {Array<Feature>} -  array of street features.
 */
function getStreetFeatures(OSM_data) {
	let street_features = [];

	for (let i =  0; i < OSM_data.features.length; ++i) {
		let feature = OSM_data.features[i];
		
		if (feature.geometry.type === "LineString" && feature.properties.highway) {
			let street_feature = feature;

			street_features.push(street_feature);
		}
	}

	return street_features;
}

/**
 * Given two anchors, find four nearby points on either side
 * of the street appropriate to build a unit(s) on.
 *
 * @param {Array<Array<Feature>>} unit_anchors -  array of pairs of points around which to anchor units along a street.
 * @param {Array<Feature>} proposed_unit_features -  array of features representing real estate units already proposed for construction.
 * @param {string} street_feature_id - The Leaflet layer ID of the street feature along which the unit is being constructed..
 * @returns {Array<Feature>} unit_features -  array of features representing real estate units.
 */
function generateUnitFeatures(unit_anchors, proposed_unit_features, street_feature_id) {
	//One sub-array of unit features for each side of the road.
	let unit_features = [[],[]],
	starting_id = proposed_unit_features.length,
	increment = 1;
	
	for (let anchor_pair of unit_anchors) {
		//Pair of unit_features opposite each other on a street.
		let unit_pair = [null, null];
		
		for (let i of [1, -1]) {
			let anchor_a = anchor_pair[0].geometry.coordinates,
			anchor_b = anchor_pair[1].geometry.coordinates,
			anchor_latLng_pair = [anchor_a, anchor_b],
			street_buffer = 6 / 1000, //Distance between center of street and start of unit.
			house_depth = 18 / 1000,
			angle = bearing(anchor_a, anchor_b),
			new_angle = angle <= 90 ? angle + i * 90 : angle - i * 90, //gle of line perpendicular to the anchor segment.
			unit_feature = { 
				type: "Feature",
				properties: {
					street: "none"
				},
				geometry: {
					type: "Polygon",
					coordinates: [[]]
				}
			};
			unit_feature.geometry.coordinates[0][0] = destination(anchor_a, street_buffer, new_angle).geometry.coordinates,
			unit_feature.geometry.coordinates[0][1] = destination(anchor_b, street_buffer, new_angle).geometry.coordinates,
			unit_feature.geometry.coordinates[0][2] = destination(anchor_b, street_buffer + house_depth, new_angle).geometry.coordinates,
			unit_feature.geometry.coordinates[0][3] = destination(anchor_a, street_buffer + house_depth, new_angle).geometry.coordinates;
			unit_feature.geometry.coordinates[0][4] = unit_feature.geometry.coordinates[0][0];

			//Exclude the unit if it overlaps with any of the other proposed units.
			let all_proposed_unit_features = unit_features.concat(...proposed_unit_features); 
			if (noOverlaps(unit_feature, all_proposed_unit_features)) { 
				//Recode index so that it's useful here.
				if (i === 1) {
					i = 0;
				}
				else {
					i = 1;
				}

				unit_feature.properties.street_id = street_feature_id,
				unit_feature.properties.street_anchors = anchor_latLng_pair,	
				unit_feature.properties.neighbors = [null, null, null],
				unit_feature.properties.id = starting_id + increment,
				increment += 1;
				
				if (unit_features[i].length !== 0) {
					//Make previous unit_feature this unit_feature's first neighbor.
					unit_feature.properties.neighbors[0] = unit_features[i][unit_features[i].length - 1],
					//Make this unit_feature the previous unit_feature's second neighbor.
					unit_features[i][unit_features[i].length - 1].properties.neighbors[1] = unit_feature;
				}
				
				if (i === 0) {
					unit_pair[0] = unit_feature;
				}
				else {
					//Make unit_feature opposite to this unit_feature on the street its third neighbor.
					unit_feature.properties.neighbors[2] = unit_pair[0],
					//Make unit_feature opposite to this unit_feature on the street's third neighbor this unit_feature.
					unit_pair[0].properties.neighbors[2] = unit_feature,

					unit_pair[1] = unit_feature;
				}
			}
		}
		
		if (unit_pair[0] !== null) {
			unit_features[0].push(unit_pair[0]);
		}

		if (unit_pair[1] !== null) {
			unit_features[1].push(unit_pair[1]);
		}
	}

	let unit_features_merged = [].concat(...unit_features);

	return unit_features_merged;
}

/**
 * Find anchors for potential units. chors are the pairs of start 
 * and end points along the street from which units may be constructed.
 * 
 * @param {Feature} street_feature - A GeoJSON feature object representing a street.
 * @returns {Array<Array<Feature>>} -  array of pairs of points around which to anchor units along a street.  
 */
function getUnitAnchors(street_feature, bounding_box) {
	let unit_anchors = [],
	unit_length = 14 / 1000, //Kilometers.
	unit_buffer = 3 / 1000, //Distance between units, kilometers.
	endpoint = street_feature.geometry.coordinates[street_feature.geometry.coordinates.length - 1],
	start_anchor = along(street_feature, 0),
	end_anchor = along(street_feature, unit_length),
	distance_along = unit_length;
	
	while (end_anchor.geometry.coordinates != endpoint) {
		//Exclude proposed anchors if they're outside of the bounding box.
		start_coord = reversedCoordinates(start_anchor.geometry.coordinates), 
		end_coord = reversedCoordinates(end_anchor.geometry.coordinates);
		if (L.latLngBounds(bounding_box).contains(start_coord) &&
			L.latLngBounds(bounding_box).contains(end_coord)) {
				unit_anchors.push([start_anchor, end_anchor]);
		}

		//Find next pair of anchors.
		start_anchor = along(street_feature, distance_along + unit_buffer);
		end_anchor = along(street_feature, distance_along + unit_buffer + unit_length);
		
		distance_along += unit_buffer + unit_length
	}

	return unit_anchors;
}

/**
 * Get an array of units excluding units that overlap with streets.
 *
 * @param {Array<Feature>} unit_features - ray of features representing units.
 * @param {Array<Layer>} street_layers - ray of Leaflet layers representing streets.
 * @returns {Array<Feature>} - unit_features, but with all units that intersect any streets removed.
 */
function unitsOutOfStreets(unit_features, street_layers) {
	let processed_unit_features = unit_features.slice();
	
	street_layers.eachLayer(function(street_layer) {
		let street_feature = street_layer.feature;
		for (let unit_feature of processed_unit_features) {
			let intersection_exists = lineIntersect(street_feature, unit_feature).features.length > 0;
			if (intersection_exists) {
				processed_unit_features.splice(processed_unit_features.indexOf(unit_feature), 1, null);
			}
		}	
	
		processed_unit_features = processed_unit_features.filter(feature => feature === null ? false : true);
	});
	

	return processed_unit_features;
}

/**
 * Check whether a polygon overlaps with any member of an array of polygons.
 *
 * @param {Feature} polygon_feature - A geoJSON polygon feature.
 * @param {Array<Feature>} polygon_feature_array -  array of geoJSON polygon features.
 * @returns {boolean} - Whether the polygon_feature overlaps with any one in the array.
 */	
function noOverlaps(reference_polygon_feature, polygon_feature_array) {
	return true;
	for (feature_array_element of polygon_feature_array) {
		let overlap_exists = intersect(reference_polygon_feature, feature_array_element);
		if (overlap_exists) {
			return false;
		}
	}
	return true;
}

/**
 * Given a geoJSON geometry object's coordinates, return the object, but with
 * all the coordinates reversed. <br /point.geometry && point.geometry.coordinates && >
 * 
 * Why? GeoJSON coordinates are in lngLat format by default, while Leaflet uses latLng.
 * L.geoJSON will auto-reverse the order of a GeoJSON object's coordinates, as it
 * expects geoJSON coordinates to be lngLat. However, normal, non-GeoJSON-specific Leaflet
 * methods expect Leaflet's latLng pairs and won't auto-reverse, so we have to do that
 * manually if we're preprocessing the GeoJSON data before passing it to L.geoJSON.
 * 
 * @param {Array<number|Array<number|Array<number>>>} coordinates - GeoJSON coordinates for a point, (multi-)line, or (multi-)polygon.
 * @returns {Array<number|Array<number|Array<number>>>} - Reversed geoJSON coordinates for a point, (multi-)line, or (multi-)polygon.
 */
function reversedCoordinates(coordinates) {
	let reversed = coordinates.slice();
	if (typeof coordinates[0] != "number") {
		for (let inner_coordinates of coordinates) {
			reversed.splice(reversed.indexOf(inner_coordinates), 1, reversedCoordinates(inner_coordinates));
		}
	}
	else {
		reversed = [coordinates[1], coordinates[0]];
	}

	return reversed;
}

/**
 * Given an array, check whether it can represent the coordinates of a point.
 *
 * @param {Array} array - Array to check.
 * @returns {boolean} - Whether the array can be the coordinates of a point.
 */
function isPointCoordinates(array) {
	if (array.length !== 2 || 
		typeof(array[0]) !== "number" ||
		typeof(array[1]) !== "number") {
		return false;
	}

	return true;
}

/**
 * Given either a GeoJSON feature, L.latLng, or coordinate array containing the coordinates of a point,
 * return an array of the coordinates.
 *
 * @params {Point|Array<number>|LatLng} point - The data containing the point's coordinates (latitude & longitude).
 * @returns {Array<number>} - Array of the point's coordinates. I.e.: [lng, lat].
 */
function pointToCoordinateArray(point) {
	let coordinate_array;

	if (typeof(point.lat) === "number" && typeof(point.lng) === "number") {
		coordinate_array = [point.lng, point.lat];
	}
	else if (point.geometry && point.geometry.coordinates && isPointCoordinates(point.geometry.coordinates)) {
		coordinate_array = point.geometry.coordinates;
	}
	else if (isPointCoordinates(point)) {
		coordinate_array = point;
	}
	else {
		throw new Error("Invalid point: point must either be array of 2 coordinates, or an L.latLng.");
	}

	return coordinate_array;
}

/**
 * Given two coordinate arrays, get their intersection.
 * 
 * @param {array<array<number>>} arr_a -  array of coordinate pairs.
 * @param {array<array<number>>} arr_b -  array of coordinate pairs.
 * @param {array<number>} with_indices -  array whose elements are IDs for arr_a and arr_b respectively.
 *
 * @returns {array<array<number, object>>} -  array whose elements are the coordinates in the intersection if
 * with_indices is empty, or whose elements are arrays whose first element is an intersecting coordinate pair
 * and whose second element is an object mapping the each array's ID (supplied in with_indices, a and b respectively) 
 * to the index of the intersecting coordinate pair in it.
 */
function getIntersection(arr_a, arr_b, with_indices = []) {
	let intersection = [];

	for (let i = 0; i < arr_a.length; i++) {
		let el_a = arr_a[i];

		for (let j = 0; j < arr_b.length; j++) {
			let el_b = arr_b[j];
			
			if (isPointCoordinates(el_a) && isPointCoordinates(el_b)) {
				if (el_a[0] === el_b[0] && el_a[1] === el_b[1]) {
					let new_intersection;
					if (with_indices.length === 2) {
						let indices = {};
						indices[with_indices[0]] = i,
						indices[with_indices[1]] = j,
						new_intersection = [el_a, indices];
					}
					else {
						new_intersection = el_a;
					}
				
					intersection.push(new_intersection);
				}
			}
			else {
				throw new Error("Every element of each array must be a coordinate pair array.");
			}
		}
	}

	return intersection;
}

Agentmap.prototype.buildingify = buildingify;

exports.getIntersection = getIntersection;
exports.reversedCoordinates = reversedCoordinates;
exports.isPointCoordinates = isPointCoordinates;
exports.pointToCoordinateArray = pointToCoordinateArray;

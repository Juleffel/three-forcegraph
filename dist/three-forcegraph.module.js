import { BufferAttribute, BufferGeometry, Group, Mesh, MeshLambertMaterial, SphereGeometry } from 'three';
import { forceCenter, forceLink, forceManyBody, forceSimulation } from 'd3-force-3d';
import graph from 'ngraph.graph';
import forcelayout from 'ngraph.forcelayout';
import forcelayout3d from 'ngraph.forcelayout3d';
import Kapsule from 'kapsule';
import qwest from 'qwest';
import accessorFn from 'accessor-fn';
import { schemePaired } from 'd3-scale-chromatic';
import tinyColor from 'tinycolor2';

var colorStr2Hex = function colorStr2Hex(str) {
  return isNaN(str) ? parseInt(tinyColor(str).toHex(), 16) : str;
};

// Autoset attribute colorField by colorByAccessor property
// If an object has already a color, don't set it
// Objects can be nodes or links
function autoColorObjects(objects, colorByAccessor, colorField) {
  if (!colorByAccessor || typeof colorField !== 'string') return;

  var colors = schemePaired; // Paired color set from color brewer

  var uncoloredObjects = objects.filter(function (obj) {
    return !obj[colorField];
  });
  var objGroups = {};

  uncoloredObjects.forEach(function (obj) {
    objGroups[colorByAccessor(obj)] = null;
  });
  Object.keys(objGroups).forEach(function (group, idx) {
    objGroups[group] = idx;
  });

  uncoloredObjects.forEach(function (obj) {
    obj[colorField] = colors[objGroups[colorByAccessor(obj)] % colors.length];
  });
}

var three$1 = window.THREE ? window.THREE // Prefer consumption from global THREE, if exists
: {
  SphereGeometry: SphereGeometry,
  BufferGeometry: BufferGeometry,
  BufferAttribute: BufferAttribute,
  Mesh: Mesh,
  MeshLambertMaterial: MeshLambertMaterial,
  Line: Line,
  LineBasicMaterial: LineBasicMaterial
};

var ngraph = { graph: graph, forcelayout: forcelayout, forcelayout3d: forcelayout3d };

//

var ForceGraph = Kapsule({

  props: {
    jsonUrl: {},
    graphData: {
      default: {
        nodes: [],
        links: []
      },
      onChange: function onChange(_, state) {
        state.onFrame = null;
      } // Pause simulation

    },
    numDimensions: {
      default: 3,
      onChange: function onChange(numDim, state) {
        if (numDim < 3) {
          eraseDimension(state.graphData.nodes, 'z');
        }
        if (numDim < 2) {
          eraseDimension(state.graphData.nodes, 'y');
        }

        function eraseDimension(nodes, dim) {
          nodes.forEach(function (d) {
            delete d[dim]; // position
            delete d['v' + dim]; // velocity
          });
        }
      }
    },
    nodeRelSize: { default: 4 }, // volume per val unit
    nodeId: { default: 'id' },
    nodeVal: { default: 'val' },
    nodeResolution: { default: 8 }, // how many slice segments in the sphere's circumference
    nodeColor: { default: 'color' },
    nodeAutoColorBy: {},
    nodeOpacity: { default: 0.75 },
    nodeThreeObject: {},
    linkSource: { default: 'source' },
    linkTarget: { default: 'target' },
    linkColor: { default: 'color' },
    linkAutoColorBy: {},
    linkOpacity: { default: 0.2 },
    linkVal: { default: 'val' }, // Rounded to nearest integer and multiplied by linkDefaultWidth
    linkDefaultWidth: { default: 1 },
    linkResolution: { default: 6 }, // how many radial segments in the cylinder geometry
    forceEngine: { default: 'd3' }, // d3 or ngraph
    d3AlphaDecay: { default: 0.0228 },
    d3VelocityDecay: { default: 0.4 },
    warmupTicks: { default: 0 }, // how many times to tick the force engine at init before starting to render
    cooldownTicks: { default: Infinity },
    cooldownTime: { default: 15000 }, // ms
    onLoading: { default: function _default() {}, triggerUpdate: false },
    onFinishLoading: { default: function _default() {}, triggerUpdate: false }
  },

  aliases: {
    autoColorBy: 'nodeAutoColorBy'
  },

  methods: {
    // Expose d3 forces for external manipulation
    d3Force: function d3Force(state, forceName, forceFn) {
      if (forceFn === undefined) {
        return state.d3ForceLayout.force(forceName); // Force getter
      }
      state.d3ForceLayout.force(forceName, forceFn); // Force setter
      return this;
    },
    tickFrame: function tickFrame(state) {
      if (state.onFrame) state.onFrame();
      return this;
    }
  },

  stateInit: function stateInit() {
    return {
      d3ForceLayout: forceSimulation().force('link', forceLink()).force('charge', forceManyBody()).force('center', forceCenter()).stop()
    };
  },

  init: function init(threeObj, state) {
    // Main three object to manipulate
    state.graphScene = threeObj;
  },
  update: function update(state) {
    state.onFrame = null; // Pause simulation
    state.onLoading();

    if (state.graphData.nodes.length || state.graphData.links.length) {
      console.info('force-graph loading', state.graphData.nodes.length + ' nodes', state.graphData.links.length + ' links');
    }

    if (!state.fetchingJson && state.jsonUrl && !state.graphData.nodes.length && !state.graphData.links.length) {
      // (Re-)load data
      state.fetchingJson = true;
      qwest.get(state.jsonUrl).then(function (_, json) {
        state.fetchingJson = false;
        state.graphData = json;
        state._rerender(); // Force re-update
      });
    }

    if (state.nodeAutoColorBy !== null) {
      // Auto add color to uncolored nodes
      autoColorObjects(state.graphData.nodes, accessorFn(state.nodeAutoColorBy), state.nodeColor);
    }
    if (state.linkAutoColorBy !== null) {
      // Auto add color to uncolored links
      autoColorObjects(state.graphData.links, accessorFn(state.linkAutoColorBy), state.linkColor);
    }

    // parse links
    state.graphData.links.forEach(function (link) {
      link.source = link[state.linkSource];
      link.target = link[state.linkTarget];
    });

    // Add WebGL objects
    while (state.graphScene.children.length) {
      state.graphScene.remove(state.graphScene.children[0]);
    } // Clear the place

    var customNodeObjectAccessor = accessorFn(state.nodeThreeObject);
    var valAccessor = accessorFn(state.nodeVal);
    var colorAccessor = accessorFn(state.nodeColor);
    var sphereGeometries = {}; // indexed by node value
    var sphereMaterials = {}; // indexed by color
    state.graphData.nodes.forEach(function (node) {
      var customObj = customNodeObjectAccessor(node);

      var obj = void 0;
      if (customObj) {
        obj = customObj.clone();
      } else {
        // Default object (sphere mesh)
        var val = valAccessor(node) || 1;
        if (!sphereGeometries.hasOwnProperty(val)) {
          sphereGeometries[val] = new three$1.SphereGeometry(Math.cbrt(val) * state.nodeRelSize, state.nodeResolution, state.nodeResolution);
        }

        var color = colorAccessor(node);
        if (!sphereMaterials.hasOwnProperty(color)) {
          sphereMaterials[color] = new three$1.MeshLambertMaterial({
            color: colorStr2Hex(color || '#ffffaa'),
            transparent: true,
            opacity: state.nodeOpacity
          });
        }

        obj = new three$1.Mesh(sphereGeometries[val], sphereMaterials[color]);
      }

      obj.__graphObjType = 'node'; // Add object type
      obj.__data = node; // Attach node data

      state.graphScene.add(node.__threeObj = obj);
    });

    var linkColorAccessor = accessorFn(state.linkColor);
    var linkValAccessor = accessorFn(state.linkVal);
    var cylinderGeometries = {}; // indexed by val
    var cylinderMaterials = {}; // indexed by color
    state.graphData.links.forEach(function (link) {
      var color = linkColorAccessor(link);
      var val = linkValAccessor(link) || 1;
      var d = val * state.linkDefaultWidth / 2;
      if (!cylinderGeometries.hasOwnProperty(val)) {
        cylinderGeometries[val] = new THREE.CylinderGeometry(d, d, 1, state.linkResolution);
        cylinderGeometries[val].applyMatrix(new THREE.Matrix4().makeTranslation(0, 1 / 2, 0));
        cylinderGeometries[val].applyMatrix(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      }
      if (!cylinderMaterials.hasOwnProperty(color)) {
        cylinderMaterials[color] = new THREE.MeshLambertMaterial({
          color: colorStr2Hex(color || '#f0f0f0'),
          transparent: true,
          opacity: state.linkOpacity
        });
      }

      var line = new THREE.Mesh(cylinderGeometries[val], cylinderMaterials[color]);

      line.renderOrder = 10; // Prevent visual glitches of dark lines on top of nodes by rendering them last

      line.__graphObjType = 'link'; // Add object type
      line.__data = link; // Attach link data

      state.graphScene.add(link.__lineObj = line);
    });

    // Feed data to force-directed layout
    var isD3Sim = state.forceEngine !== 'ngraph';
    var layout = void 0;
    if (isD3Sim) {
      // D3-force
      (layout = state.d3ForceLayout).stop().alpha(1) // re-heat the simulation
      .alphaDecay(state.d3AlphaDecay).velocityDecay(state.d3VelocityDecay).numDimensions(state.numDimensions).nodes(state.graphData.nodes).force('link').id(function (d) {
        return d[state.nodeId];
      }).links(state.graphData.links);
    } else {
      // ngraph
      var _graph = ngraph.graph();
      state.graphData.nodes.forEach(function (node) {
        _graph.addNode(node[state.nodeId]);
      });
      state.graphData.links.forEach(function (link) {
        _graph.addLink(link.source, link.target);
      });
      layout = ngraph['forcelayout' + (state.numDimensions === 2 ? '' : '3d')](_graph);
      layout.graph = _graph; // Attach graph reference to layout
    }

    for (var i = 0; i < state.warmupTicks; i++) {
      layout[isD3Sim ? 'tick' : 'step']();
    } // Initial ticks before starting to render

    var cntTicks = 0;
    var startTickTime = new Date();
    state.onFrame = layoutTick;
    state.onFinishLoading();

    //

    function layoutTick() {
      if (++cntTicks > state.cooldownTicks || new Date() - startTickTime > state.cooldownTime) {
        state.onFrame = null; // Stop ticking graph
      } else {
        layout[isD3Sim ? 'tick' : 'step'](); // Tick it
      }

      // Update nodes position
      state.graphData.nodes.forEach(function (node) {
        var obj = node.__threeObj;
        if (!obj) return;

        var pos = isD3Sim ? node : layout.getNodePosition(node[state.nodeId]);

        obj.position.x = pos.x;
        obj.position.y = pos.y || 0;
        obj.position.z = pos.z || 0;
      });

      // Update links position
      state.graphData.links.forEach(function (link) {
        var line = link.__lineObj;
        if (!line) return;

        var pos = isD3Sim ? link : layout.getLinkPosition(layout.graph.getLink(link.source, link.target).id),
            start = pos[isD3Sim ? 'source' : 'from'],
            end = pos[isD3Sim ? 'target' : 'to'],
            vstart = new THREE.Vector3(start.x, start.y || 0, start.z || 0),
            vend = new THREE.Vector3(end.x, end.y || 0, end.z || 0),
            distance = vstart.distanceTo(vend);

        line.position.x = vstart.x;
        line.position.y = vstart.y;
        line.position.z = vstart.z;
        line.lookAt(vend);
        line.scale.z = distance;
      });
    }
  }
});

var classCallCheck = function (instance, Constructor) {
  if (!(instance instanceof Constructor)) {
    throw new TypeError("Cannot call a class as a function");
  }
};











var inherits = function (subClass, superClass) {
  if (typeof superClass !== "function" && superClass !== null) {
    throw new TypeError("Super expression must either be null or a function, not " + typeof superClass);
  }

  subClass.prototype = Object.create(superClass && superClass.prototype, {
    constructor: {
      value: subClass,
      enumerable: false,
      writable: true,
      configurable: true
    }
  });
  if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass;
};











var possibleConstructorReturn = function (self, call) {
  if (!self) {
    throw new ReferenceError("this hasn't been initialised - super() hasn't been called");
  }

  return call && (typeof call === "object" || typeof call === "function") ? call : self;
};



















var toConsumableArray = function (arr) {
  if (Array.isArray(arr)) {
    for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) arr2[i] = arr[i];

    return arr2;
  } else {
    return Array.from(arr);
  }
};

function fromKapsule (kapsule) {
  var baseClass = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : Object;
  var initKapsuleWithSelf = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : false;

  var FromKapsule = function (_baseClass) {
    inherits(FromKapsule, _baseClass);

    function FromKapsule() {
      var _ref;

      classCallCheck(this, FromKapsule);

      for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }

      var _this = possibleConstructorReturn(this, (_ref = FromKapsule.__proto__ || Object.getPrototypeOf(FromKapsule)).call.apply(_ref, [this].concat(args)));

      _this.__kapsuleInstance = kapsule().apply(undefined, [].concat(toConsumableArray(initKapsuleWithSelf ? [_this] : []), args));
      return _this;
    }

    return FromKapsule;
  }(baseClass);

  // attach kapsule props/methods to class prototype


  Object.keys(kapsule()).forEach(function (m) {
    return FromKapsule.prototype[m] = function () {
      var _kapsuleInstance;

      var returnVal = (_kapsuleInstance = this.__kapsuleInstance)[m].apply(_kapsuleInstance, arguments);

      return returnVal === this.__kapsuleInstance ? this // chain based on this class, not the kapsule obj
      : returnVal;
    };
  });

  return FromKapsule;
}

var threeForcegraph = fromKapsule(ForceGraph, Group, true);

export { threeForcegraph as default };

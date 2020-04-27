"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.transformTypes = void 0;

var _node = _interopRequireDefault(require("parse/node"));

var _graphqlRelay = require("graphql-relay");

var _filesMutations = require("../loaders/filesMutations");

var defaultGraphQLTypes = _interopRequireWildcard(require("../loaders/defaultGraphQLTypes"));

var objectsMutations = _interopRequireWildcard(require("../helpers/objectsMutations"));

function _getRequireWildcardCache() { if (typeof WeakMap !== "function") return null; var cache = new WeakMap(); _getRequireWildcardCache = function () { return cache; }; return cache; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(Object(source), true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const transformTypes = async (inputType, fields, {
  className,
  parseGraphQLSchema,
  req
}) => {
  const {
    classGraphQLCreateType,
    classGraphQLUpdateType,
    config: {
      isCreateEnabled,
      isUpdateEnabled
    }
  } = parseGraphQLSchema.parseClassTypes[className];
  const parseClass = parseGraphQLSchema.parseClasses.find(clazz => clazz.className === className);

  if (fields) {
    const classGraphQLCreateTypeFields = isCreateEnabled && classGraphQLCreateType ? classGraphQLCreateType.getFields() : null;
    const classGraphQLUpdateTypeFields = isUpdateEnabled && classGraphQLUpdateType ? classGraphQLUpdateType.getFields() : null;
    const promises = Object.keys(fields).map(async field => {
      let inputTypeField;

      if (inputType === 'create' && classGraphQLCreateTypeFields) {
        inputTypeField = classGraphQLCreateTypeFields[field];
      } else if (classGraphQLUpdateTypeFields) {
        inputTypeField = classGraphQLUpdateTypeFields[field];
      }

      if (inputTypeField) {
        switch (true) {
          case inputTypeField.type === defaultGraphQLTypes.GEO_POINT_INPUT:
            fields[field] = transformers.geoPoint(fields[field]);
            break;

          case inputTypeField.type === defaultGraphQLTypes.POLYGON_INPUT:
            fields[field] = transformers.polygon(fields[field]);
            break;

          case inputTypeField.type === defaultGraphQLTypes.FILE_INPUT:
            fields[field] = await transformers.file(fields[field], req);
            break;

          case parseClass.fields[field].type === 'Relation':
            fields[field] = await transformers.relation(parseClass.fields[field].targetClass, field, fields[field], parseGraphQLSchema, req);
            break;

          case parseClass.fields[field].type === 'Pointer':
            fields[field] = await transformers.pointer(parseClass.fields[field].targetClass, field, fields[field], parseGraphQLSchema, req);
            break;
        }
      }
    });
    await Promise.all(promises);
    if (fields.ACL) fields.ACL = transformers.ACL(fields.ACL);
  }

  return fields;
};

exports.transformTypes = transformTypes;
const transformers = {
  file: async ({
    file,
    upload
  }, {
    config
  }) => {
    if (file === null && !upload) {
      return null;
    }

    if (upload) {
      const {
        fileInfo
      } = await (0, _filesMutations.handleUpload)(upload, config);
      return _objectSpread({}, fileInfo, {
        __type: 'File'
      });
    } else if (file && file.name) {
      return {
        name: file.name,
        __type: 'File',
        url: file.url
      };
    }

    throw new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, 'Invalid file upload.');
  },
  polygon: value => ({
    __type: 'Polygon',
    coordinates: value.map(geoPoint => [geoPoint.latitude, geoPoint.longitude])
  }),
  geoPoint: value => _objectSpread({}, value, {
    __type: 'GeoPoint'
  }),
  ACL: value => {
    const parseACL = {};

    if (value.public) {
      parseACL['*'] = {
        read: value.public.read,
        write: value.public.write
      };
    }

    if (value.users) {
      value.users.forEach(rule => {
        const globalIdObject = (0, _graphqlRelay.fromGlobalId)(rule.userId);

        if (globalIdObject.type === '_User') {
          rule.userId = globalIdObject.id;
        }

        parseACL[rule.userId] = {
          read: rule.read,
          write: rule.write
        };
      });
    }

    if (value.roles) {
      value.roles.forEach(rule => {
        parseACL[`role:${rule.roleName}`] = {
          read: rule.read,
          write: rule.write
        };
      });
    }

    return parseACL;
  },
  relation: async (targetClass, field, value, parseGraphQLSchema, {
    config,
    auth,
    info
  }) => {
    if (Object.keys(value).length === 0) throw new _node.default.Error(_node.default.Error.INVALID_POINTER, `You need to provide at least one operation on the relation mutation of field ${field}`);
    const op = {
      __op: 'Batch',
      ops: []
    };
    let nestedObjectsToAdd = [];

    if (value.createAndAdd) {
      nestedObjectsToAdd = (await Promise.all(value.createAndAdd.map(async input => {
        const parseFields = await transformTypes('create', input, {
          className: targetClass,
          parseGraphQLSchema,
          req: {
            config,
            auth,
            info
          }
        });
        return objectsMutations.createObject(targetClass, parseFields, config, auth, info);
      }))).map(object => ({
        __type: 'Pointer',
        className: targetClass,
        objectId: object.objectId
      }));
    }

    if (value.add || nestedObjectsToAdd.length > 0) {
      if (!value.add) value.add = [];
      value.add = value.add.map(input => {
        const globalIdObject = (0, _graphqlRelay.fromGlobalId)(input);

        if (globalIdObject.type === targetClass) {
          input = globalIdObject.id;
        }

        return {
          __type: 'Pointer',
          className: targetClass,
          objectId: input
        };
      });
      op.ops.push({
        __op: 'AddRelation',
        objects: [...value.add, ...nestedObjectsToAdd]
      });
    }

    if (value.remove) {
      op.ops.push({
        __op: 'RemoveRelation',
        objects: value.remove.map(input => {
          const globalIdObject = (0, _graphqlRelay.fromGlobalId)(input);

          if (globalIdObject.type === targetClass) {
            input = globalIdObject.id;
          }

          return {
            __type: 'Pointer',
            className: targetClass,
            objectId: input
          };
        })
      });
    }

    return op;
  },
  pointer: async (targetClass, field, value, parseGraphQLSchema, {
    config,
    auth,
    info
  }) => {
    if (Object.keys(value).length > 1 || Object.keys(value).length === 0) throw new _node.default.Error(_node.default.Error.INVALID_POINTER, `You need to provide link OR createLink on the pointer mutation of field ${field}`);
    let nestedObjectToAdd;

    if (value.createAndLink) {
      const parseFields = await transformTypes('create', value.createAndLink, {
        className: targetClass,
        parseGraphQLSchema,
        req: {
          config,
          auth,
          info
        }
      });
      nestedObjectToAdd = await objectsMutations.createObject(targetClass, parseFields, config, auth, info);
      return {
        __type: 'Pointer',
        className: targetClass,
        objectId: nestedObjectToAdd.objectId
      };
    }

    if (value.link) {
      let objectId = value.link;
      const globalIdObject = (0, _graphqlRelay.fromGlobalId)(objectId);

      if (globalIdObject.type === targetClass) {
        objectId = globalIdObject.id;
      }

      return {
        __type: 'Pointer',
        className: targetClass,
        objectId
      };
    }
  }
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9HcmFwaFFML3RyYW5zZm9ybWVycy9tdXRhdGlvbi5qcyJdLCJuYW1lcyI6WyJ0cmFuc2Zvcm1UeXBlcyIsImlucHV0VHlwZSIsImZpZWxkcyIsImNsYXNzTmFtZSIsInBhcnNlR3JhcGhRTFNjaGVtYSIsInJlcSIsImNsYXNzR3JhcGhRTENyZWF0ZVR5cGUiLCJjbGFzc0dyYXBoUUxVcGRhdGVUeXBlIiwiY29uZmlnIiwiaXNDcmVhdGVFbmFibGVkIiwiaXNVcGRhdGVFbmFibGVkIiwicGFyc2VDbGFzc1R5cGVzIiwicGFyc2VDbGFzcyIsInBhcnNlQ2xhc3NlcyIsImZpbmQiLCJjbGF6eiIsImNsYXNzR3JhcGhRTENyZWF0ZVR5cGVGaWVsZHMiLCJnZXRGaWVsZHMiLCJjbGFzc0dyYXBoUUxVcGRhdGVUeXBlRmllbGRzIiwicHJvbWlzZXMiLCJPYmplY3QiLCJrZXlzIiwibWFwIiwiZmllbGQiLCJpbnB1dFR5cGVGaWVsZCIsInR5cGUiLCJkZWZhdWx0R3JhcGhRTFR5cGVzIiwiR0VPX1BPSU5UX0lOUFVUIiwidHJhbnNmb3JtZXJzIiwiZ2VvUG9pbnQiLCJQT0xZR09OX0lOUFVUIiwicG9seWdvbiIsIkZJTEVfSU5QVVQiLCJmaWxlIiwicmVsYXRpb24iLCJ0YXJnZXRDbGFzcyIsInBvaW50ZXIiLCJQcm9taXNlIiwiYWxsIiwiQUNMIiwidXBsb2FkIiwiZmlsZUluZm8iLCJfX3R5cGUiLCJuYW1lIiwidXJsIiwiUGFyc2UiLCJFcnJvciIsIkZJTEVfU0FWRV9FUlJPUiIsInZhbHVlIiwiY29vcmRpbmF0ZXMiLCJsYXRpdHVkZSIsImxvbmdpdHVkZSIsInBhcnNlQUNMIiwicHVibGljIiwicmVhZCIsIndyaXRlIiwidXNlcnMiLCJmb3JFYWNoIiwicnVsZSIsImdsb2JhbElkT2JqZWN0IiwidXNlcklkIiwiaWQiLCJyb2xlcyIsInJvbGVOYW1lIiwiYXV0aCIsImluZm8iLCJsZW5ndGgiLCJJTlZBTElEX1BPSU5URVIiLCJvcCIsIl9fb3AiLCJvcHMiLCJuZXN0ZWRPYmplY3RzVG9BZGQiLCJjcmVhdGVBbmRBZGQiLCJpbnB1dCIsInBhcnNlRmllbGRzIiwib2JqZWN0c011dGF0aW9ucyIsImNyZWF0ZU9iamVjdCIsIm9iamVjdCIsIm9iamVjdElkIiwiYWRkIiwicHVzaCIsIm9iamVjdHMiLCJyZW1vdmUiLCJuZXN0ZWRPYmplY3RUb0FkZCIsImNyZWF0ZUFuZExpbmsiLCJsaW5rIl0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBQUE7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7Ozs7Ozs7Ozs7Ozs7O0FBRUEsTUFBTUEsY0FBYyxHQUFHLE9BQ3JCQyxTQURxQixFQUVyQkMsTUFGcUIsRUFHckI7QUFBRUMsRUFBQUEsU0FBRjtBQUFhQyxFQUFBQSxrQkFBYjtBQUFpQ0MsRUFBQUE7QUFBakMsQ0FIcUIsS0FJbEI7QUFDSCxRQUFNO0FBQ0pDLElBQUFBLHNCQURJO0FBRUpDLElBQUFBLHNCQUZJO0FBR0pDLElBQUFBLE1BQU0sRUFBRTtBQUFFQyxNQUFBQSxlQUFGO0FBQW1CQyxNQUFBQTtBQUFuQjtBQUhKLE1BSUZOLGtCQUFrQixDQUFDTyxlQUFuQixDQUFtQ1IsU0FBbkMsQ0FKSjtBQUtBLFFBQU1TLFVBQVUsR0FBR1Isa0JBQWtCLENBQUNTLFlBQW5CLENBQWdDQyxJQUFoQyxDQUNoQkMsS0FBRCxJQUFXQSxLQUFLLENBQUNaLFNBQU4sS0FBb0JBLFNBRGQsQ0FBbkI7O0FBR0EsTUFBSUQsTUFBSixFQUFZO0FBQ1YsVUFBTWMsNEJBQTRCLEdBQ2hDUCxlQUFlLElBQUlILHNCQUFuQixHQUNJQSxzQkFBc0IsQ0FBQ1csU0FBdkIsRUFESixHQUVJLElBSE47QUFJQSxVQUFNQyw0QkFBNEIsR0FDaENSLGVBQWUsSUFBSUgsc0JBQW5CLEdBQ0lBLHNCQUFzQixDQUFDVSxTQUF2QixFQURKLEdBRUksSUFITjtBQUlBLFVBQU1FLFFBQVEsR0FBR0MsTUFBTSxDQUFDQyxJQUFQLENBQVluQixNQUFaLEVBQW9Cb0IsR0FBcEIsQ0FBd0IsTUFB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T0FBUDtBQUtEOztBQUNELFFBQUk5QixLQUFLLENBQUNxQyxJQUFWLEVBQWdCO0FBQ2QsVUFBSVAsUUFBUSxHQUFHOUIsS0FBSyxDQUFDcUMsSUFBckI7QUFDQSxZQUFNMUIsY0FBYyxHQUFHLGdDQUFhbUIsUUFBYixDQUF2Qjs7QUFDQSxVQUFJbkIsY0FBYyxDQUFDbEMsSUFBZixLQUF3QlUsV0FBNUIsRUFBeUM7QUFDdkMyQyxRQUFBQSxRQUFRLEdBQUduQixjQUFjLENBQUNFLEVBQTFCO0FBQ0Q7O0FBQ0QsYUFBTztBQUNMbkIsUUFBQUEsTUFBTSxFQUFFLFNBREg7QUFFTHZDLFFBQUFBLFNBQVMsRUFBRWdDLFdBRk47QUFHTDJDLFFBQUFBO0FBSEssT0FBUDtBQUtEO0FBQ0Y7QUFwTGtCLENBQXJCIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFBhcnNlIGZyb20gJ3BhcnNlL25vZGUnO1xuaW1wb3J0IHsgZnJvbUdsb2JhbElkIH0gZnJvbSAnZ3JhcGhxbC1yZWxheSc7XG5pbXBvcnQgeyBoYW5kbGVVcGxvYWQgfSBmcm9tICcuLi9sb2FkZXJzL2ZpbGVzTXV0YXRpb25zJztcbmltcG9ydCAqIGFzIGRlZmF1bHRHcmFwaFFMVHlwZXMgZnJvbSAnLi4vbG9hZGVycy9kZWZhdWx0R3JhcGhRTFR5cGVzJztcbmltcG9ydCAqIGFzIG9iamVjdHNNdXRhdGlvbnMgZnJvbSAnLi4vaGVscGVycy9vYmplY3RzTXV0YXRpb25zJztcblxuY29uc3QgdHJhbnNmb3JtVHlwZXMgPSBhc3luYyAoXG4gIGlucHV0VHlwZTogJ2NyZWF0ZScgfCAndXBkYXRlJyxcbiAgZmllbGRzLFxuICB7IGNsYXNzTmFtZSwgcGFyc2VHcmFwaFFMU2NoZW1hLCByZXEgfVxuKSA9PiB7XG4gIGNvbnN0IHtcbiAgICBjbGFzc0dyYXBoUUxDcmVhdGVUeXBlLFxuICAgIGNsYXNzR3JhcGhRTFVwZGF0ZVR5cGUsXG4gICAgY29uZmlnOiB7IGlzQ3JlYXRlRW5hYmxlZCwgaXNVcGRhdGVFbmFibGVkIH0sXG4gIH0gPSBwYXJzZUdyYXBoUUxTY2hlbWEucGFyc2VDbGFzc1R5cGVzW2NsYXNzTmFtZV07XG4gIGNvbnN0IHBhcnNlQ2xhc3MgPSBwYXJzZUdyYXBoUUxTY2hlbWEucGFyc2VDbGFzc2VzLmZpbmQoXG4gICAgKGNsYXp6KSA9PiBjbGF6ei5jbGFzc05hbWUgPT09IGNsYXNzTmFtZVxuICApO1xuICBpZiAoZmllbGRzKSB7XG4gICAgY29uc3QgY2xhc3NHcmFwaFFMQ3JlYXRlVHlwZUZpZWxkcyA9XG4gICAgICBpc0NyZWF0ZUVuYWJsZWQgJiYgY2xhc3NHcmFwaFFMQ3JlYXRlVHlwZVxuICAgICAgICA/IGNsYXNzR3JhcGhRTENyZWF0ZVR5cGUuZ2V0RmllbGRzKClcbiAgICAgICAgOiBudWxsO1xuICAgIGNvbnN0IGNsYXNzR3JhcGhRTFVwZGF0ZVR5cGVGaWVsZHMgPVxuICAgICAgaXNVcGRhdGVFbmFibGVkICYmIGNsYXNzR3JhcGhRTFVwZGF0ZVR5cGVcbiAgICAgICAgPyBjbGFzc0dyYXBoUUxVcGRhdGVUeXBlLmdldEZpZWxkcygpXG4gICAgICAgIDogbnVsbDtcbiAgICBjb25zdCBwcm9taXNlcyA9IE9iamVjdC5rZXlzKGZpZWxkcykubWFwKGFzeW5jIChmaWVsZCkgPT4ge1xuICAgICAgbGV0IGlucHV0VHlwZUZpZWxkO1xuICAgICAgaWYgKGlucHV0VHlwZSA9PT0gJ2NyZWF0ZScgJiYgY2xhc3NHcmFwaFFMQ3JlYXRlVHlwZUZpZWxkcykge1xuICAgICAgICBpbnB1dFR5cGVGaWVsZCA9IGNsYXNzR3JhcGhRTENyZWF0ZVR5cGVGaWVsZHNbZmllbGRdO1xuICAgICAgfSBlbHNlIGlmIChjbGFzc0dyYXBoUUxVcGRhdGVUeXBlRmllbGRzKSB7XG4gICAgICAgIGlucHV0VHlwZUZpZWxkID0gY2xhc3NHcmFwaFFMVXBkYXRlVHlwZUZpZWxkc1tmaWVsZF07XG4gICAgICB9XG4gICAgICBpZiAoaW5wdXRUeXBlRmllbGQpIHtcbiAgICAgICAgc3dpdGNoICh0cnVlKSB7XG4gICAgICAgICAgY2FzZSBpbnB1dFR5cGVGaWVsZC50eXBlID09PSBkZWZhdWx0R3JhcGhRTFR5cGVzLkdFT19QT0lOVF9JTlBVVDpcbiAgICAgICAgICAgIGZpZWxkc1tmaWVsZF0gPSB0cmFuc2Zvcm1lcnMuZ2VvUG9pbnQoZmllbGRzW2ZpZWxkXSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlIGlucHV0VHlwZUZpZWxkLnR5cGUgPT09IGRlZmF1bHRHcmFwaFFMVHlwZXMuUE9MWUdPTl9JTlBVVDpcbiAgICAgICAgICAgIGZpZWxkc1tmaWVsZF0gPSB0cmFuc2Zvcm1lcnMucG9seWdvbihmaWVsZHNbZmllbGRdKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIGNhc2UgaW5wdXRUeXBlRmllbGQudHlwZSA9PT0gZGVmYXVsdEdyYXBoUUxUeXBlcy5GSUxFX0lOUFVUOlxuICAgICAgICAgICAgZmllbGRzW2ZpZWxkXSA9IGF3YWl0IHRyYW5zZm9ybWVycy5maWxlKGZpZWxkc1tmaWVsZF0sIHJlcSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlIHBhcnNlQ2xhc3MuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUmVsYXRpb24nOlxuICAgICAgICAgICAgZmllbGRzW2ZpZWxkXSA9IGF3YWl0IHRyYW5zZm9ybWVycy5yZWxhdGlvbihcbiAgICAgICAgICAgICAgcGFyc2VDbGFzcy5maWVsZHNbZmllbGRdLnRhcmdldENsYXNzLFxuICAgICAgICAgICAgICBmaWVsZCxcbiAgICAgICAgICAgICAgZmllbGRzW2ZpZWxkXSxcbiAgICAgICAgICAgICAgcGFyc2VHcmFwaFFMU2NoZW1hLFxuICAgICAgICAgICAgICByZXFcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlIHBhcnNlQ2xhc3MuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9pbnRlcic6XG4gICAgICAgICAgICBmaWVsZHNbZmllbGRdID0gYXdhaXQgdHJhbnNmb3JtZXJzLnBvaW50ZXIoXG4gICAgICAgICAgICAgIHBhcnNlQ2xhc3MuZmllbGRzW2ZpZWxkXS50YXJnZXRDbGFzcyxcbiAgICAgICAgICAgICAgZmllbGQsXG4gICAgICAgICAgICAgIGZpZWxkc1tmaWVsZF0sXG4gICAgICAgICAgICAgIHBhcnNlR3JhcGhRTFNjaGVtYSxcbiAgICAgICAgICAgICAgcmVxXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcbiAgICBhd2FpdCBQcm9taXNlLmFsbChwcm9taXNlcyk7XG4gICAgaWYgKGZpZWxkcy5BQ0wpIGZpZWxkcy5BQ0wgPSB0cmFuc2Zvcm1lcnMuQUNMKGZpZWxkcy5BQ0wpO1xuICB9XG4gIHJldHVybiBmaWVsZHM7XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1lcnMgPSB7XG4gIGZpbGU6IGFzeW5jICh7IGZpbGUsIHVwbG9hZCB9LCB7IGNvbmZpZyB9KSA9PiB7XG4gICAgaWYgKGZpbGUgPT09IG51bGwgJiYgIXVwbG9hZCkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGlmICh1cGxvYWQpIHtcbiAgICAgIGNvbnN0IHsgZmlsZUluZm8gfSA9IGF3YWl0IGhhbmRsZVVwbG9hZCh1cGxvYWQsIGNvbmZpZyk7XG4gICAgICByZXR1cm4geyAuLi5maWxlSW5mbywgX190eXBlOiAnRmlsZScgfTtcbiAgICB9IGVsc2UgaWYgKGZpbGUgJiYgZmlsZS5uYW1lKSB7XG4gICAgICByZXR1cm4geyBuYW1lOiBmaWxlLm5hbWUsIF9fdHlwZTogJ0ZpbGUnLCB1cmw6IGZpbGUudXJsIH07XG4gICAgfVxuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5GSUxFX1NBVkVfRVJST1IsICdJbnZhbGlkIGZpbGUgdXBsb2FkLicpO1xuICB9LFxuICBwb2x5Z29uOiAodmFsdWUpID0+ICh7XG4gICAgX190eXBlOiAnUG9seWdvbicsXG4gICAgY29vcmRpbmF0ZXM6IHZhbHVlLm1hcCgoZ2VvUG9pbnQpID0+IFtcbiAgICAgIGdlb1BvaW50LmxhdGl0dWRlLFxuICAgICAgZ2VvUG9pbnQubG9uZ2l0dWRlLFxuICAgIF0pLFxuICB9KSxcbiAgZ2VvUG9pbnQ6ICh2YWx1ZSkgPT4gKHtcbiAgICAuLi52YWx1ZSxcbiAgICBfX3R5cGU6ICdHZW9Qb2ludCcsXG4gIH0pLFxuICBBQ0w6ICh2YWx1ZSkgPT4ge1xuICAgIGNvbnN0IHBhcnNlQUNMID0ge307XG4gICAgaWYgKHZhbHVlLnB1YmxpYykge1xuICAgICAgcGFyc2VBQ0xbJyonXSA9IHtcbiAgICAgICAgcmVhZDogdmFsdWUucHVibGljLnJlYWQsXG4gICAgICAgIHdyaXRlOiB2YWx1ZS5wdWJsaWMud3JpdGUsXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAodmFsdWUudXNlcnMpIHtcbiAgICAgIHZhbHVlLnVzZXJzLmZvckVhY2goKHJ1bGUpID0+IHtcbiAgICAgICAgY29uc3QgZ2xvYmFsSWRPYmplY3QgPSBmcm9tR2xvYmFsSWQocnVsZS51c2VySWQpO1xuICAgICAgICBpZiAoZ2xvYmFsSWRPYmplY3QudHlwZSA9PT0gJ19Vc2VyJykge1xuICAgICAgICAgIHJ1bGUudXNlcklkID0gZ2xvYmFsSWRPYmplY3QuaWQ7XG4gICAgICAgIH1cbiAgICAgICAgcGFyc2VBQ0xbcnVsZS51c2VySWRdID0ge1xuICAgICAgICAgIHJlYWQ6IHJ1bGUucmVhZCxcbiAgICAgICAgICB3cml0ZTogcnVsZS53cml0ZSxcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAodmFsdWUucm9sZXMpIHtcbiAgICAgIHZhbHVlLnJvbGVzLmZvckVhY2goKHJ1bGUpID0+IHtcbiAgICAgICAgcGFyc2VBQ0xbYHJvbGU6JHtydWxlLnJvbGVOYW1lfWBdID0ge1xuICAgICAgICAgIHJlYWQ6IHJ1bGUucmVhZCxcbiAgICAgICAgICB3cml0ZTogcnVsZS53cml0ZSxcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm4gcGFyc2VBQ0w7XG4gIH0sXG4gIHJlbGF0aW9uOiBhc3luYyAoXG4gICAgdGFyZ2V0Q2xhc3MsXG4gICAgZmllbGQsXG4gICAgdmFsdWUsXG4gICAgcGFyc2VHcmFwaFFMU2NoZW1hLFxuICAgIHsgY29uZmlnLCBhdXRoLCBpbmZvIH1cbiAgKSA9PiB7XG4gICAgaWYgKE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGggPT09IDApXG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUE9JTlRFUixcbiAgICAgICAgYFlvdSBuZWVkIHRvIHByb3ZpZGUgYXQgbGVhc3Qgb25lIG9wZXJhdGlvbiBvbiB0aGUgcmVsYXRpb24gbXV0YXRpb24gb2YgZmllbGQgJHtmaWVsZH1gXG4gICAgICApO1xuXG4gICAgY29uc3Qgb3AgPSB7XG4gICAgICBfX29wOiAnQmF0Y2gnLFxuICAgICAgb3BzOiBbXSxcbiAgICB9O1xuICAgIGxldCBuZXN0ZWRPYmplY3RzVG9BZGQgPSBbXTtcblxuICAgIGlmICh2YWx1ZS5jcmVhdGVBbmRBZGQpIHtcbiAgICAgIG5lc3RlZE9iamVjdHNUb0FkZCA9IChcbiAgICAgICAgYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICAgICAgdmFsdWUuY3JlYXRlQW5kQWRkLm1hcChhc3luYyAoaW5wdXQpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHBhcnNlRmllbGRzID0gYXdhaXQgdHJhbnNmb3JtVHlwZXMoJ2NyZWF0ZScsIGlucHV0LCB7XG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogdGFyZ2V0Q2xhc3MsXG4gICAgICAgICAgICAgIHBhcnNlR3JhcGhRTFNjaGVtYSxcbiAgICAgICAgICAgICAgcmVxOiB7IGNvbmZpZywgYXV0aCwgaW5mbyB9LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm4gb2JqZWN0c011dGF0aW9ucy5jcmVhdGVPYmplY3QoXG4gICAgICAgICAgICAgIHRhcmdldENsYXNzLFxuICAgICAgICAgICAgICBwYXJzZUZpZWxkcyxcbiAgICAgICAgICAgICAgY29uZmlnLFxuICAgICAgICAgICAgICBhdXRoLFxuICAgICAgICAgICAgICBpbmZvXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pXG4gICAgICAgIClcbiAgICAgICkubWFwKChvYmplY3QpID0+ICh7XG4gICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICBjbGFzc05hbWU6IHRhcmdldENsYXNzLFxuICAgICAgICBvYmplY3RJZDogb2JqZWN0Lm9iamVjdElkLFxuICAgICAgfSkpO1xuICAgIH1cblxuICAgIGlmICh2YWx1ZS5hZGQgfHwgbmVzdGVkT2JqZWN0c1RvQWRkLmxlbmd0aCA+IDApIHtcbiAgICAgIGlmICghdmFsdWUuYWRkKSB2YWx1ZS5hZGQgPSBbXTtcbiAgICAgIHZhbHVlLmFkZCA9IHZhbHVlLmFkZC5tYXAoKGlucHV0KSA9PiB7XG4gICAgICAgIGNvbnN0IGdsb2JhbElkT2JqZWN0ID0gZnJvbUdsb2JhbElkKGlucHV0KTtcbiAgICAgICAgaWYgKGdsb2JhbElkT2JqZWN0LnR5cGUgPT09IHRhcmdldENsYXNzKSB7XG4gICAgICAgICAgaW5wdXQgPSBnbG9iYWxJZE9iamVjdC5pZDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgIGNsYXNzTmFtZTogdGFyZ2V0Q2xhc3MsXG4gICAgICAgICAgb2JqZWN0SWQ6IGlucHV0LFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgICBvcC5vcHMucHVzaCh7XG4gICAgICAgIF9fb3A6ICdBZGRSZWxhdGlvbicsXG4gICAgICAgIG9iamVjdHM6IFsuLi52YWx1ZS5hZGQsIC4uLm5lc3RlZE9iamVjdHNUb0FkZF0sXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAodmFsdWUucmVtb3ZlKSB7XG4gICAgICBvcC5vcHMucHVzaCh7XG4gICAgICAgIF9fb3A6ICdSZW1vdmVSZWxhdGlvbicsXG4gICAgICAgIG9iamVjdHM6IHZhbHVlLnJlbW92ZS5tYXAoKGlucHV0KSA9PiB7XG4gICAgICAgICAgY29uc3QgZ2xvYmFsSWRPYmplY3QgPSBmcm9tR2xvYmFsSWQoaW5wdXQpO1xuICAgICAgICAgIGlmIChnbG9iYWxJZE9iamVjdC50eXBlID09PSB0YXJnZXRDbGFzcykge1xuICAgICAgICAgICAgaW5wdXQgPSBnbG9iYWxJZE9iamVjdC5pZDtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgICAgY2xhc3NOYW1lOiB0YXJnZXRDbGFzcyxcbiAgICAgICAgICAgIG9iamVjdElkOiBpbnB1dCxcbiAgICAgICAgICB9O1xuICAgICAgICB9KSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm4gb3A7XG4gIH0sXG4gIHBvaW50ZXI6IGFzeW5jIChcbiAgICB0YXJnZXRDbGFzcyxcbiAgICBmaWVsZCxcbiAgICB2YWx1ZSxcbiAgICBwYXJzZUdyYXBoUUxTY2hlbWEsXG4gICAgeyBjb25maWcsIGF1dGgsIGluZm8gfVxuICApID0+IHtcbiAgICBpZiAoT2JqZWN0LmtleXModmFsdWUpLmxlbmd0aCA+IDEgfHwgT2JqZWN0LmtleXModmFsdWUpLmxlbmd0aCA9PT0gMClcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9QT0lOVEVSLFxuICAgICAgICBgWW91IG5lZWQgdG8gcHJvdmlkZSBsaW5rIE9SIGNyZWF0ZUxpbmsgb24gdGhlIHBvaW50ZXIgbXV0YXRpb24gb2YgZmllbGQgJHtmaWVsZH1gXG4gICAgICApO1xuXG4gICAgbGV0IG5lc3RlZE9iamVjdFRvQWRkO1xuICAgIGlmICh2YWx1ZS5jcmVhdGVBbmRMaW5rKSB7XG4gICAgICBjb25zdCBwYXJzZUZpZWxkcyA9IGF3YWl0IHRyYW5zZm9ybVR5cGVzKCdjcmVhdGUnLCB2YWx1ZS5jcmVhdGVBbmRMaW5rLCB7XG4gICAgICAgIGNsYXNzTmFtZTogdGFyZ2V0Q2xhc3MsXG4gICAgICAgIHBhcnNlR3JhcGhRTFNjaGVtYSxcbiAgICAgICAgcmVxOiB7IGNvbmZpZywgYXV0aCwgaW5mbyB9LFxuICAgICAgfSk7XG4gICAgICBuZXN0ZWRPYmplY3RUb0FkZCA9IGF3YWl0IG9iamVjdHNNdXRhdGlvbnMuY3JlYXRlT2JqZWN0KFxuICAgICAgICB0YXJnZXRDbGFzcyxcbiAgICAgICAgcGFyc2VGaWVsZHMsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgYXV0aCxcbiAgICAgICAgaW5mb1xuICAgICAgKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICBjbGFzc05hbWU6IHRhcmdldENsYXNzLFxuICAgICAgICBvYmplY3RJZDogbmVzdGVkT2JqZWN0VG9BZGQub2JqZWN0SWQsXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAodmFsdWUubGluaykge1xuICAgICAgbGV0IG9iamVjdElkID0gdmFsdWUubGluaztcbiAgICAgIGNvbnN0IGdsb2JhbElkT2JqZWN0ID0gZnJvbUdsb2JhbElkKG9iamVjdElkKTtcbiAgICAgIGlmIChnbG9iYWxJZE9iamVjdC50eXBlID09PSB0YXJnZXRDbGFzcykge1xuICAgICAgICBvYmplY3RJZCA9IGdsb2JhbElkT2JqZWN0LmlkO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgIGNsYXNzTmFtZTogdGFyZ2V0Q2xhc3MsXG4gICAgICAgIG9iamVjdElkLFxuICAgICAgfTtcbiAgICB9XG4gIH0sXG59O1xuXG5leHBvcnQgeyB0cmFuc2Zvcm1UeXBlcyB9O1xuIl19
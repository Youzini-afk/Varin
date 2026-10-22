; Full declarations, including implementation blocks and their methods.
(struct_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(union_item name: (type_identifier) @name) @definition.struct
(type_item name: (type_identifier) @name) @definition.type
(function_item name: (identifier) @name) @definition.function
(trait_item name: (type_identifier) @name) @definition.interface
(mod_item name: (identifier) @name) @definition.module
(macro_definition name: (identifier) @name) @definition.macro
(impl_item type: (_) @name) @definition.class
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.variable

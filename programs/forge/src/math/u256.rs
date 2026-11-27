//! 256-bit unsigned integer, kept in its own module so the macro's `Result` does not collide
//! with Anchor's prelude alias.
uint::construct_uint! {
    pub struct U256(4);
}

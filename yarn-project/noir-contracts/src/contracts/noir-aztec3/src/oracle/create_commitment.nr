
#[oracle(createCommitment)]
fn create_commitment_oracle(_commitment: Field) -> [Field; 1] {}

unconstrained fn create_commitment(commitment: Field) {
    constrain create_commitment_oracle(commitment)[0] == 0;
}

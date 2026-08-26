fn empirical_mean(xs: &[f64]) -> f64 {
    xs.iter().sum::<f64>() / xs.len() as f64
}

fn main() {
    println!("{}", empirical_mean(&[1.0, 2.0, 3.0]));
}
